const { Issuer, Strategy: OpenIDConnectStrategy } = require('openid-client');
const debug = require('debug');
const { findOrProvisionUser } = require('../provider-user-service.js');
const { callbackUrlFor } = require('../auth-settings-service.js');
const { toGroupArray } = require('../role-mapper.js');

const log = debug('auth:oidc');
// Raw group names reveal org structure, so they sit behind their own namespace: enabling
// `auth:oidc` alone gives diagnostics without them.
const groupsLog = debug('auth:oidc:groups');

const MAX_LOGGED_ITEMS = 50;
const MAX_LOGGED_LENGTH = 100;

/**
 * Reads a claim that may be namespaced. Auth0 and several other providers emit custom
 * claims under a URI-shaped key (e.g. `https://myapp.example/groups`), which is a flat
 * key rather than a nested path, so a plain property lookup is checked first. A dotted
 * path is then walked for providers that genuinely nest.
 */
const readClaim = (source, path) => {
  if (!source || !path) return undefined;
  if (source[path] !== undefined) return source[path];
  if (!path.includes('.')) return undefined;
  return path.split('.').reduce(
    (acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined),
    source,
  );
};

/**
 * Makes an IdP-supplied string safe to write to a log line. Claim names and group values
 * are controlled by the identity provider, so control characters (which would let a value
 * forge extra log lines) are stripped and the length is capped.
 */
const sanitiseForLog = (value) => String(value)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
  .slice(0, MAX_LOGGED_LENGTH);

/** Sanitised, capped list of an object's top-level keys. Values are deliberately not read. */
const claimNames = (source) => (source && typeof source === 'object'
  ? Object.keys(source).slice(0, MAX_LOGGED_ITEMS).map(sanitiseForLog).sort()
  : []);

/**
 * Describes where the groups claim was found and what shape it had, without including any
 * of its values. This is what tells "the IdP never sent the claim" apart from "it sent an
 * empty one" or "it sent a scalar".
 * @returns {{source: string, type: string, count: number}}
 */
const describeGroupsClaim = (claims, profile, groupsClaim) => {
  const fromToken = readClaim(claims, groupsClaim);
  const fromUserinfo = readClaim(profile, groupsClaim);
  let source = 'none';
  let value;
  if (fromToken) {
    source = 'id_token';
    value = fromToken;
  } else if (fromUserinfo) {
    source = 'userinfo';
    value = fromUserinfo;
  }
  let type = typeof value;
  if (Array.isArray(value)) type = 'array';
  return { source, type, count: toGroupArray(value).length };
};

/**
 * Ensures the `openid` scope is present exactly once - it is mandatory for OIDC, but an
 * admin editing the scope list can easily drop it or repeat it.
 */
const normaliseScopes = (scopes) => {
  const requested = String(scopes || '').split(/\s+/).filter(Boolean);
  const deduped = [...new Set(['openid', ...requested])];
  return deduped.join(' ');
};

/**
 * Builds the verify callback for a provider. openid-client invokes this with the
 * validated token set and the userinfo response.
 */
const buildVerify = (provider) => async (tokenSet, userInfo, done) => {
  try {
    const claims = tokenSet.claims();
    const profile = userInfo || {};
    const config = provider.oidc || {};

    // Prefer the configured username claim, then fall back through the conventional
    // ones. `sub` is the last resort: it is the only claim guaranteed to be present.
    const identifier = readClaim(claims, config.usernameClaim)
      || readClaim(profile, config.usernameClaim)
      || claims.email || profile.email
      || claims.preferred_username || profile.preferred_username
      || claims.sub;

    // Groups may arrive in the ID token or from the userinfo endpoint depending on how
    // the authorization server is configured to emit them.
    const groups = readClaim(claims, config.groupsClaim)
      || readClaim(profile, config.groupsClaim)
      || [];

    // Diagnostics for group mapping problems. Logs claim *names* and the shape of the groups
    // claim, never claim values, tokens or the userinfo payload - those carry PII and
    // credentials.
    const found = describeGroupsClaim(claims, profile, config.groupsClaim);
    log(
      'Login claims for %s via provider %s: idTokenClaims=[%s] userinfoClaims=[%s] '
      + 'scopes=[%s] groupsClaim=%s groupsSource=%s groupsType=%s groupsCount=%d',
      sanitiseForLog(identifier),
      provider.id,
      claimNames(claims).join(','),
      claimNames(profile).join(','),
      sanitiseForLog(tokenSet.scope || ''),
      sanitiseForLog(config.groupsClaim || '(not configured)'),
      found.source,
      found.type,
      found.count,
    );
    if (groupsLog.enabled) {
      const names = toGroupArray(groups);
      groupsLog(
        'Groups received for %s via provider %s (%d, showing up to %d): [%s]',
        sanitiseForLog(identifier),
        provider.id,
        names.length,
        MAX_LOGGED_ITEMS,
        names.slice(0, MAX_LOGGED_ITEMS).map(sanitiseForLog).join(', '),
      );
    }

    // Entra ID omits the groups claim entirely when the user is in more than ~200 groups,
    // substituting a claim-sources pointer to the Graph API. Detect that explicitly so it
    // surfaces as a clear log line rather than a silent "no permission" denial.
    const overage = readClaim(claims, '_claim_names');
    if (overage && overage[config.groupsClaim]) {
      log(
        'Provider %s returned a groups overage claim for %s; group membership was not '
        + 'evaluated. Configure a group filter on the IdP, or use application roles instead.',
        provider.id,
        identifier,
      );
    }

    const { user, message } = await findOrProvisionUser({
      username: identifier,
      groups,
      provider,
    });

    if (!user) return done(null, false, { message });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
};

/**
 * Builds a passport OIDC strategy for the provider via OIDC discovery: the issuer's
 * .well-known/openid-configuration supplies every endpoint plus the JWKS used to validate
 * the ID token signature.
 *
 * Works against any spec-compliant provider (Okta, Entra ID, Google, Keycloak, Auth0,
 * Authentik, Ping, Cognito, GitLab) - which one it is only affects the configured scopes
 * and claim names.
 *
 * @returns {Promise<Strategy>} the configured strategy
 * @throws when the provider is incompletely configured or discovery fails
 */
exports.build = async (provider) => {
  const config = provider.oidc || {};
  if (!config.issuer || !config.clientId || !config.clientSecret) {
    throw new Error('issuer, clientId and clientSecret are all required');
  }

  // The issuer is entered free-text in the admin UI; strip any trailing slash before
  // discovery so it resolves cleanly.
  const issuerUrl = config.issuer.replace(/\/+$/, '');
  const issuer = await Issuer.discover(issuerUrl);
  const client = new issuer.Client({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uris: [callbackUrlFor(provider.id)],
    response_types: ['code'],
  });

  log('Discovered issuer %s for provider %s', issuer.issuer, provider.id);

  return new OpenIDConnectStrategy({
    client,
    // Authorization code flow with PKCE (S256). The library also generates and verifies
    // state for CSRF protection on the callback, and validates the returned ID token
    // (signature against the discovered JWKS, plus issuer/audience/expiry) before the
    // verify callback runs.
    usePKCE: 'S256',
    params: { scope: normaliseScopes(config.scopes) },
  }, buildVerify(provider));
};

exports.buildVerify = buildVerify;
exports.describeGroupsClaim = describeGroupsClaim;
exports.sanitiseForLog = sanitiseForLog;
exports.readClaim = readClaim;
exports.normaliseScopes = normaliseScopes;

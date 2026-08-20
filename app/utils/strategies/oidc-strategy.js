const { Issuer, Strategy: OpenIDConnectStrategy } = require('openid-client');
const debug = require('debug');
const { findOrProvisionUser } = require('../provider-user-service.js');
const { callbackUrlFor } = require('../auth-settings-service.js');

const log = debug('auth:oidc');

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

exports.readClaim = readClaim;
exports.normaliseScopes = normaliseScopes;

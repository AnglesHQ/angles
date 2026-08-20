const crypto = require('crypto');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const debug = require('debug');
const { findOrProvisionUser } = require('../provider-user-service.js');
const { callbackUrlFor } = require('../auth-settings-service.js');

const log = debug('auth:saml');

// Attributes an IdP commonly uses for the username, tried in order when the admin has
// not named one explicitly. The SAML spec fixes none of these, so IdPs differ: ADFS and
// Entra emit the long claim URIs, Keycloak and Shibboleth the short names.
const USERNAME_ATTRIBUTES = [
  'email',
  'mail',
  'emailAddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'uid',
  'urn:oid:0.9.2342.19200300.100.1.1',
];

/**
 * Normalises a PEM certificate as pasted into the admin UI.
 *
 * Admins paste these out of IdP metadata or a downloaded .cer in every shape imaginable:
 * with or without the BEGIN/END armour, wrapped at 64 columns or as one long line, and
 * with CRLF line endings. node-saml wants the bare base64 body, so strip the armour and
 * all whitespace.
 */
const normaliseCert = (cert) => String(cert || '')
  .replace(/-----BEGIN CERTIFICATE-----/g, '')
  .replace(/-----END CERTIFICATE-----/g, '')
  .replace(/\s+/g, '')
  .trim();

/**
 * Pulls a named attribute out of a SAML profile, tolerating the several shapes IdPs use.
 * A multi-valued attribute may arrive as an array, and node-saml sometimes exposes the
 * value under an object with a `value` key.
 */
const readAttribute = (profile, name) => {
  if (!profile || !name) return undefined;
  const value = profile[name] !== undefined
    ? profile[name]
    : (profile.attributes || {})[name];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => (entry && entry.value !== undefined ? entry.value : entry));
  }
  if (typeof value === 'object' && value.value !== undefined) return value.value;
  return value;
};

/**
 * Resolves the username from the assertion: the configured attribute if the admin named
 * one, otherwise the conventional attributes, and finally the NameID - which is what the
 * default emailAddress identifier format is expected to carry.
 */
const resolveUsername = (profile, config) => {
  if (config.usernameAttribute) {
    const configured = readAttribute(profile, config.usernameAttribute);
    if (configured) return Array.isArray(configured) ? configured[0] : configured;
  }
  const found = USERNAME_ATTRIBUTES
    .map((name) => readAttribute(profile, name))
    .find((value) => value);
  if (found) return Array.isArray(found) ? found[0] : found;

  // nameID is transient for some identifier formats, but for the emailAddress and
  // persistent formats it is the stable subject identifier.
  return profile.nameID;
};

/**
 * Builds a passport SAML strategy for the provider.
 *
 * The IdP's signing certificate is mandatory: assertions are only trustworthy because
 * their signature verifies against it, so a provider without one is refused rather than
 * registered in a state where any party could forge an assertion.
 *
 * @returns {Promise<Strategy>} the configured strategy
 * @throws when the provider is incompletely configured
 */
exports.build = async (provider) => {
  const config = provider.saml || {};

  if (!config.entryPoint) {
    throw new Error('entryPoint (the IdP SSO URL) is required');
  }
  const idpCert = normaliseCert(config.idpCert);
  if (!idpCert) {
    throw new Error('idpCert (the IdP signing certificate) is required to verify assertions');
  }
  if (!config.issuer) {
    throw new Error('issuer (this application\'s SP entity id) is required');
  }

  // Signing AuthnRequests is optional, but a key that cannot be parsed must be caught
  // here rather than at login: node-saml only fails when it tries to sign, which would
  // otherwise surface as an opaque 500 on the redirect for every user.
  const privateKey = config.privateKey || undefined;
  if (privateKey) {
    try {
      crypto.createPrivateKey(privateKey);
    } catch (err) {
      throw new Error(`privateKey is not a valid PEM private key: ${err.message}`);
    }
  }

  const callbackUrl = callbackUrlFor(provider.id);

  const verify = async (profile, done) => {
    try {
      const username = resolveUsername(profile, config);
      const groups = readAttribute(profile, config.groupsAttribute || 'groups') || [];

      const { user, message } = await findOrProvisionUser({ username, groups, provider });
      if (!user) return done(null, false, { message });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  };

  log('Configured SAML strategy for provider %s (ACS %s)', provider.id, callbackUrl);

  return new SamlStrategy({
    entryPoint: config.entryPoint,
    callbackUrl,
    issuer: config.issuer,
    idpCert,
    identifierFormat: config.identifierFormat || null,
    signatureAlgorithm: config.signatureAlgorithm || 'sha256',
    digestAlgorithm: config.signatureAlgorithm || 'sha256',
    // Signing our AuthnRequests is optional and only needed when the IdP requires it.
    privateKey,
    // Reject an unsigned assertion. Without this an attacker could strip the signature
    // and present arbitrary claims, which is the classic SAML bypass. Always on - it is
    // the guarantee the whole flow rests on, so it is deliberately not configurable.
    wantAssertionsSigned: true,
    // Whether the enclosing Response must also be signed. Configurable because IdPs
    // differ on this, but defaults to required.
    wantAuthnResponseSigned: config.wantAuthnResponseSigned !== false,
    // IdP-initiated login has no AuthnRequest to correlate against, so it loses the
    // replay/CSRF protection the SP-initiated flow gets from InResponseTo. Off unless
    // opted into.
    //
    // 'always' (rather than 'ifPresent') is what actually rejects an unsolicited
    // assertion: 'ifPresent' only checks the value when the IdP chose to send one, so an
    // attacker replaying an assertion simply omits it.
    //
    // Note this correlation uses node-saml's in-memory request cache. Across multiple
    // Angles instances a login begun on one and completed on another would be rejected,
    // so such deployments need sticky sessions on the SAML routes - the same requirement
    // the session-backed OIDC state check already imposes.
    allowUnsolicitedResponses: config.allowUnsolicited === true,
    validateInResponseTo: config.allowUnsolicited === true ? 'never' : 'always',
    // Small tolerance for clock drift between this host and the IdP, which is otherwise a
    // common cause of spurious "assertion not yet valid" failures.
    acceptedClockSkewMs: 5000,
    disableRequestedAuthnContext: true,
  }, verify, verify);
};

exports.normaliseCert = normaliseCert;
exports.readAttribute = readAttribute;
exports.resolveUsername = resolveUsername;

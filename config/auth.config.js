require('dotenv').config();
const crypto = require('crypto');

// The session signing key. Anyone who knows it can forge a session cookie for any account,
// including an admin, so there is deliberately no hard-coded fallback: a shipped default
// is public by definition and would be a trivial authentication bypass.
//
// In production a missing SESSION_SECRET is fatal: a per-process random key would break
// as soon as the app runs as more than one instance (load-balanced or mid rolling deploy),
// because a session signed by one instance would be rejected by the others.
//
// Elsewhere (tests, local development) we generate a random key per process instead, which
// is safe - the only consequence is that sessions do not survive a restart.
//
// Note this key only signs browser session cookies. API tokens are independent - they are
// random values compared by hash (see user.controller/auth-middleware) and are unaffected
// by a regenerated key.
const resolveSessionSecret = () => {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error('FATAL: SESSION_SECRET must be set when NODE_ENV=production.');
    process.exit(1);
  }
  return crypto.randomBytes(32).toString('hex');
};

// The public origin the API is reached on, without a trailing slash: where identity
// providers send users back to. ANGLES_BASE_URL sets it explicitly. Without it, the API's
// own public URL (ANGLES_API_BASE_URL, which deployments already set for the UI and the
// Swagger docs) is used, so a deployment that sets that one does not silently register
// http://localhost:3000 with its identity provider. Like Swagger, a value without a
// scheme takes the first of SWAGGER_SCHEMES.
const resolveBaseUrl = () => {
  const explicit = (process.env.ANGLES_BASE_URL || '').trim();
  const apiUrl = (process.env.ANGLES_API_BASE_URL || '').trim();
  let baseUrl = explicit || apiUrl || 'http://localhost:3000';
  if (!/^https?:\/\//i.test(baseUrl)) {
    const scheme = (process.env.SWAGGER_SCHEMES || 'http').split(',')[0].trim() || 'http';
    baseUrl = `${scheme}://${baseUrl}`;
  }
  return baseUrl.replace(/\/+$/, '');
};

// These are only the in-memory defaults used before the persisted settings load at
// startup. All authentication configuration (which providers exist, whether they are
// enabled, issuers, client ids, secrets, group mappings) is managed exclusively through
// the admin UI and stored in the database - it is NOT read from environment variables.
// The auth-settings service loads the database document at startup and mutates this
// object in place.
//
// The two exceptions below are genuine deployment/infrastructure values, not user config:
// - sessionSecret: the session signing key (see resolveSessionSecret above).
// - baseUrl: the public origin, used to derive each provider's callback URL. It depends
//   on where the app is hosted and must match what is registered with the IdP (see
//   resolveBaseUrl above).
module.exports = {
  resolveBaseUrl,
  localAuthEnabled: true,
  sessionSecret: resolveSessionSecret(),
  // Public origin of this Angles instance, without a trailing slash.
  baseUrl: resolveBaseUrl(),
  // Populated from the database at startup by auth-settings-service.
  providers: [],
};

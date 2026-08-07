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

// These are only the in-memory defaults used before the persisted settings load at
// startup. All authentication configuration (whether Okta is enabled, issuer, client id,
// client secret, group mappings) is managed exclusively through the admin UI and stored
// in the database - it is NOT read from environment variables. The auth-settings service
// loads the database document at startup and mutates this object in place.
//
// The two exceptions below are genuine deployment/infrastructure values, not user config:
// - sessionSecret: the session signing key (see resolveSessionSecret above).
// - okta.callbackURL: the public OIDC redirect URL, which depends on where the app is hosted.
module.exports = {
  authType: 'local', // derived mirror of oktaAuthEnabled: 'local' or 'okta'
  localAuthEnabled: true,
  oktaAuthEnabled: false,
  sessionSecret: resolveSessionSecret(),
  okta: {
    domain: '',
    issuer: '',
    clientID: '',
    clientSecret: '',
    callbackURL: process.env.OKTA_CALLBACK_URL || 'http://localhost:3000/auth/okta/callback',
    adminGroup: '',
    teamLeadGroup: '',
    userGroup: '',
  },
};

require('dotenv').config();

// These are only the in-memory defaults used before the persisted settings load at
// startup. All authentication configuration (whether Okta is enabled, issuer, client id,
// client secret, group mappings) is managed exclusively through the admin UI and stored
// in the database - it is NOT read from environment variables. The auth-settings service
// loads the database document at startup and mutates this object in place.
//
// The two exceptions below are genuine deployment/infrastructure values, not user config:
// - sessionSecret: the session signing key.
// - okta.callbackURL: the public OIDC redirect URL, which depends on where the app is hosted.
module.exports = {
  authType: 'local', // derived mirror of oktaAuthEnabled: 'local' or 'okta'
  localAuthEnabled: true,
  oktaAuthEnabled: false,
  sessionSecret: process.env.SESSION_SECRET || 'angles-super-secret-key-change-me',
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

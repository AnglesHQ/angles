require('dotenv').config();

module.exports = {
  authType: process.env.AUTH_TYPE || 'local', // 'local' or 'okta'
  sessionSecret: process.env.SESSION_SECRET || 'angles-super-secret-key-change-me',
  okta: {
    issuer: process.env.OKTA_ISSUER,
    clientID: process.env.OKTA_CLIENT_ID,
    clientSecret: process.env.OKTA_CLIENT_SECRET,
    callbackURL: process.env.OKTA_CALLBACK_URL || 'http://localhost:3000/auth/okta/callback',
  },
};

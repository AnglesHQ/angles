const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const OpenIDConnectStrategy = require('passport-openidconnect').Strategy;
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const authConfig = require('../../config/auth.config');
const debug = require('debug');
const log = debug('auth:passport');

// Serialize user ID to session
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id).lean();
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// Local Strategy
passport.use(new LocalStrategy({
  usernameField: 'username',
  passwordField: 'password',
}, async (username, password, done) => {
  try {
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) {
      return done(null, false, { message: 'Incorrect username or password.' });
    }
    if (user.authProvider !== 'local') {
      return done(null, false, { message: 'Use SSO to login.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      return done(null, user);
    }
    return done(null, false, { message: 'Incorrect username or password.' });
  } catch (err) {
    return done(err);
  }
}));

// Okta Strategy (only initialize if Okta is configured)
if (authConfig.authType === 'okta' && authConfig.okta.issuer) {
  passport.use('oidc', new OpenIDConnectStrategy({
    issuer: authConfig.okta.issuer,
    authorizationURL: `${authConfig.okta.issuer}/v1/authorize`,
    tokenURL: `${authConfig.okta.issuer}/v1/token`,
    userInfoURL: `${authConfig.okta.issuer}/v1/userinfo`,
    clientID: authConfig.okta.clientID,
    clientSecret: authConfig.okta.clientSecret,
    callbackURL: authConfig.okta.callbackURL,
    scope: ['openid', 'profile', 'email'],
  }, async (issuer, profile, done) => {
    try {
      // Find user by email or username
      const username = profile.emails && profile.emails.length > 0 
        ? profile.emails[0].value 
        : profile.username || profile.id;
      
      let user = await User.findOne({ username: username.toLowerCase() });

      if (!user) {
        // Auto-provision user on first login
        user = new User({
          username: username.toLowerCase(),
          authProvider: 'okta',
          role: 'user', // Default role
          teams: [],
        });
        await user.save();
        log(`Provisioned new Okta user: ${username}`);
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}

module.exports = passport;

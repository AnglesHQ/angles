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
    scope: ['openid', 'profile', 'email', 'groups'],
  }, async (issuer, profile, done) => {
    try {
      // Find user by email or username
      const username = profile.emails && profile.emails.length > 0 
        ? profile.emails[0].value 
        : profile.username || profile.id;
      
      // Extract groups from profile
      // Depending on Okta config, groups could be in profile._json.groups or profile.groups
      const groups = profile._json?.groups || profile.groups || [];
      let newRole = 'user'; // Default role
      let isAuthorized = true;

      // Determine role based on group membership
      if (authConfig.okta.adminGroup && groups.includes(authConfig.okta.adminGroup)) {
        newRole = 'admin';
      } else if (authConfig.okta.userGroup) {
        if (groups.includes(authConfig.okta.userGroup)) {
          newRole = 'user';
        } else {
          isAuthorized = false; // User not in admin or user group
        }
      }

      if (!isAuthorized) {
        log(`User ${username} denied access: Not in required Okta groups.`);
        return done(null, false, { message: 'You do not have permission to access this application.' });
      }

      let user = await User.findOne({ username: username.toLowerCase() });

      if (!user) {
        // Auto-provision user on first login
        user = new User({
          username: username.toLowerCase(),
          authProvider: 'okta',
          role: newRole,
          teams: [],
        });
        await user.save();
        log(`Provisioned new Okta user: ${username} with role: ${newRole}`);
      } else {
        // Sync role if it has changed (only for okta users)
        if (user.role !== newRole && user.authProvider === 'okta') {
          user.role = newRole;
          await user.save();
          log(`Updated role for Okta user: ${username} to: ${newRole}`);
        }
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}

module.exports = passport;

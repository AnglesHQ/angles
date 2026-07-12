const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const OpenIDConnectStrategy = require('passport-openidconnect').Strategy;
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const authConfig = require('../../config/auth.config');
const { resolveRoleFromGroups } = require('./role-mapper');
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

// Verify callback shared by every Okta strategy registration.
const oktaVerify = async (issuer, profile, done) => {
  try {
    // Find user by email or username
    const username = profile.emails && profile.emails.length > 0
      ? profile.emails[0].value
      : profile.username || profile.id;

    // Extract groups from profile
    // Depending on Okta config, groups could be in profile._json.groups or profile.groups
    const groups = profile._json?.groups || profile.groups || [];

    // Map Okta groups to an Angles role (admin > team_lead > user). Returns null
    // when the user belongs to none of the configured groups.
    const newRole = resolveRoleFromGroups(groups);

    if (!newRole) {
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
};

/**
 * (Re)registers the Okta OIDC strategy from the current authConfig values, or removes
 * it when Okta is disabled / not configured. Safe to call at startup and again whenever
 * the admin updates the auth settings, so issuer/client changes take effect without a
 * restart.
 */
const configureOktaStrategy = () => {
  const oktaReady = authConfig.oktaAuthEnabled && authConfig.okta.issuer && authConfig.okta.clientID;
  if (oktaReady) {
    // The issuer is entered free-text in the admin UI; strip any trailing slash so the
    // derived endpoint URLs don't end up with a double slash (e.g. '…//v1/authorize').
    const issuer = authConfig.okta.issuer.replace(/\/+$/, '');
    passport.use('oidc', new OpenIDConnectStrategy({
      issuer,
      authorizationURL: `${issuer}/v1/authorize`,
      tokenURL: `${issuer}/v1/token`,
      userInfoURL: `${issuer}/v1/userinfo`,
      clientID: authConfig.okta.clientID,
      clientSecret: authConfig.okta.clientSecret,
      callbackURL: authConfig.okta.callbackURL,
      // The strategy always prepends the required 'openid' scope, so it is omitted here
      // to avoid a duplicate in the authorization request.
      scope: ['profile', 'email', 'groups'],
      // Send and verify a nonce for ID token replay protection (state/CSRF is already
      // handled by the strategy's session state store).
      nonce: true,
    }, oktaVerify));
    log('Okta OIDC strategy configured.');
  } else {
    try {
      passport.unuse('oidc');
      log('Okta OIDC strategy removed (Okta disabled or not configured).');
    } catch (err) {
      // Strategy was not registered; nothing to remove.
    }
  }
};

// Register once at startup from whatever values are currently loaded (env defaults).
// server.js calls this again after the persisted settings are loaded from the database.
configureOktaStrategy();

module.exports = { passport, configureOktaStrategy };

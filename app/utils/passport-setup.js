const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { Issuer, Strategy: OpenIDConnectStrategy } = require('openid-client');
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

// Tracks whether the OIDC strategy is currently registered and usable. Because
// configuration is asynchronous (OIDC discovery), Okta can be enabled in settings while
// the strategy is momentarily unavailable (e.g. discovery failed); the auth routes use
// this to avoid invoking an unregistered strategy.
let oktaStrategyReady = false;

const removeOktaStrategy = () => {
  oktaStrategyReady = false;
  try {
    passport.unuse('oidc');
  } catch (err) {
    // Strategy was not registered; nothing to remove.
  }
};

// Verify callback shared by every Okta strategy registration. openid-client invokes this
// with the validated token set and the userinfo response.
const oktaVerify = async (tokenSet, userInfo, done) => {
  try {
    const claims = tokenSet.claims();
    const profile = userInfo || {};

    // Prefer the email claim; fall back to preferred_username and finally the subject.
    const identifier = claims.email || profile.email
      || claims.preferred_username || profile.preferred_username
      || claims.sub;

    if (!identifier) {
      return done(null, false, { message: 'Unable to determine a username from the Okta profile.' });
    }
    const username = identifier.toLowerCase();

    // Groups may arrive as an ID token claim or from the userinfo endpoint, depending on
    // how the Okta authorization server is configured to emit the groups claim.
    const groups = claims.groups || profile.groups || [];

    // Map Okta groups to an Angles role (admin > team_lead > user). Returns null
    // when the user belongs to none of the configured groups.
    const newRole = resolveRoleFromGroups(groups);

    if (!newRole) {
      log(`User ${username} denied access: Not in required Okta groups.`);
      return done(null, false, { message: 'You do not have permission to access this application.' });
    }

    let user = await User.findOne({ username });

    if (!user) {
      // Auto-provision user on first login
      user = new User({
        username,
        authProvider: 'okta',
        role: newRole,
        teams: [],
      });
      await user.save();
      log(`Provisioned new Okta user: ${username} with role: ${newRole}`);
    } else if (user.role !== newRole && user.authProvider === 'okta') {
      // Sync role if it has changed (only for okta users)
      user.role = newRole;
      await user.save();
      log(`Updated role for Okta user: ${username} to: ${newRole}`);
    }
    return done(null, user);
  } catch (err) {
    return done(err);
  }
};

/**
 * (Re)registers the Okta OIDC strategy from the current authConfig values using OIDC
 * discovery (the issuer's .well-known/openid-configuration provides all endpoints and the
 * JWKS for token validation), or removes it when Okta is disabled / not fully configured.
 *
 * Asynchronous because of the discovery request. Safe to call at startup and again
 * whenever the admin updates the auth settings, so changes take effect without a restart.
 * @returns {Promise<boolean>} whether the strategy is registered afterwards
 */
const configureOktaStrategy = async () => {
  const oktaReady = authConfig.oktaAuthEnabled
    && authConfig.okta.issuer
    && authConfig.okta.clientID
    && authConfig.okta.clientSecret;

  if (!oktaReady) {
    removeOktaStrategy();
    return false;
  }

  try {
    // The issuer is entered free-text in the admin UI; strip any trailing slash before
    // discovery so it resolves cleanly.
    const issuerUrl = authConfig.okta.issuer.replace(/\/+$/, '');
    const issuer = await Issuer.discover(issuerUrl);
    const client = new issuer.Client({
      client_id: authConfig.okta.clientID,
      client_secret: authConfig.okta.clientSecret,
      redirect_uris: [authConfig.okta.callbackURL],
      response_types: ['code'],
    });

    passport.use('oidc', new OpenIDConnectStrategy({
      client,
      // Authorization code flow with PKCE (S256). The library also generates and verifies
      // state for CSRF protection on the callback, and validates the returned ID token
      // (signature against the discovered JWKS, plus issuer/audience/expiry) before the
      // verify callback runs.
      usePKCE: 'S256',
      params: { scope: 'openid profile email groups' },
    }, oktaVerify));

    oktaStrategyReady = true;
    log('Okta OIDC strategy configured via discovery for issuer %s', issuer.issuer);
    return true;
  } catch (err) {
    removeOktaStrategy();
    log('Failed to configure Okta OIDC strategy: %s', err.message);
    return false;
  }
};

const isOktaStrategyReady = () => oktaStrategyReady;

module.exports = { passport, configureOktaStrategy, isOktaStrategyReady };

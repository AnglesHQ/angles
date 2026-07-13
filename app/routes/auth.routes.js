const { check, validationResult } = require('express-validator');
const passport = require('passport');
const authConfig = require('../../config/auth.config');
const { isOktaStrategyReady } = require('../utils/passport-setup');

module.exports = (app, path) => {
  // Config
  app.get(`${path}/auth/config`, (req, res) => {
    res.json({
      localAuthEnabled: authConfig.localAuthEnabled !== false,
      oktaAuthEnabled: authConfig.oktaAuthEnabled === true
    });
  });

  // Local Authentication
  app.post(`${path}/auth/login`, [
    check('username')
      .exists({ checkFalsy: true })
      .isLength({ min: 2, max: 50 })
      .withMessage('Username must be between 2 and 50 characters.'),
    check('password')
      .exists({ checkFalsy: true })
      .isLength({ min: 1, max: 100 })
      .withMessage('Password is required.'),
  ], (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }
    return passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ error: info.message || 'Login failed' });
      }
      req.logIn(user, (err) => {
        if (err) return next(err);
        return res.json({ message: 'Logged in successfully', user: { _id: user._id, username: user.username, role: user.role, teams: user.teams } });
      });
    })(req, res, next);
  });

  // Okta Authentication. The routes are always registered because Okta can be enabled at
  // runtime from the admin settings; they only function once an admin has enabled and
  // configured Okta (at which point the OIDC strategy is registered). passport.authenticate
  // is invoked per-request so it picks up the currently-registered strategy.
  const oktaGuard = (req, res, next) => {
    if (!authConfig.oktaAuthEnabled) {
      return res.status(404).json({ error: 'Okta authentication is not enabled.' });
    }
    if (!isOktaStrategyReady()) {
      return res.status(503).json({ error: 'Okta authentication is enabled but not configured correctly.' });
    }
    return next();
  };

  app.get(`${path}/auth/okta`,
    oktaGuard,
    (req, res, next) => passport.authenticate('oidc')(req, res, next));

  app.get(`${path}/auth/okta/callback`,
    oktaGuard,
    (req, res, next) => passport.authenticate('oidc', { failureRedirect: '/login?error=true' })(req, res, next),
    (req, res) => {
      // Successful authentication, redirect home.
      res.redirect('/');
    });

  // Common Logout
  app.post(`${path}/auth/logout`, (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ message: 'Logged out successfully' });
    });
  });

  // Get Current User Profile
  app.get(`${path}/auth/me`, (req, res) => {
    if (req.isAuthenticated()) {
      res.json({
        _id: req.user._id,
        username: req.user.username,
        role: req.user.role,
        teams: req.user.teams,
        authProvider: req.user.authProvider,
      });
    } else {
      res.status(401).json({ error: 'Not authenticated' });
    }
  });
};

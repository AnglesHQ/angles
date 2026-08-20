const { check, validationResult } = require('express-validator');
const passport = require('passport');
const authConfig = require('../../config/auth.config.js');
const {
  isProviderReady,
  getReadyProvider,
  listEnabledProviders,
  strategyName,
} = require('../utils/passport-setup.js');

module.exports = (app, path) => {
  // Config. Drives the login page: which sign-in methods to offer, and where each goes.
  app.get(`${path}/auth/config`, (req, res) => {
    res.json({
      localAuthEnabled: authConfig.localAuthEnabled !== false,
      providers: listEnabledProviders(),
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
    if (authConfig.localAuthEnabled === false) {
      return res.status(404).json({ error: 'Local authentication is not enabled.' });
    }
    return passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ error: info.message || 'Login failed' });
      }
      return req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        return res.json({
          message: 'Logged in successfully',
          user: {
            _id: user._id, username: user.username, role: user.role, teams: user.teams,
          },
        });
      });
    })(req, res, next);
  });

  // SSO. The routes are registered once and resolve the provider per request, because
  // providers can be added, enabled and reconfigured at runtime from the admin settings.
  // The registry (not the settings) is consulted, so an enabled-but-unconfigured provider
  // reports 503 rather than passport throwing on an unregistered strategy.
  const ssoGuard = (req, res, next) => {
    const provider = (authConfig.providers || [])
      .find((candidate) => candidate.id === req.params.providerId);

    if (!provider || !provider.enabled) {
      return res.status(404).json({ error: 'Unknown or disabled authentication provider.' });
    }
    if (!isProviderReady(provider.id)) {
      return res.status(503).json({
        error: 'This authentication provider is enabled but not configured correctly.',
      });
    }
    req.ssoProvider = getReadyProvider(provider.id);
    return next();
  };

  // Begin an SSO login (redirect flows: OIDC, SAML).
  app.get(
    `${path}/auth/sso/:providerId`,
    ssoGuard,
    (req, res, next) => passport.authenticate(strategyName(req.params.providerId))(req, res, next),
  );

  // SSO callback / assertion consumer service.
  const ssoCallback = (req, res, next) => passport.authenticate(
    strategyName(req.params.providerId),
    { failureRedirect: '/login?error=true' },
  )(req, res, next);

  const ssoCallbackSuccess = (req, res) => {
    // Successful authentication, redirect home.
    res.redirect('/');
  };

  app.get(`${path}/auth/sso/:providerId/callback`, ssoGuard, ssoCallback, ssoCallbackSuccess);

  // Common Logout
  app.post(`${path}/auth/logout`, (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      return res.json({ message: 'Logged out successfully' });
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

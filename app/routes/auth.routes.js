const { check, validationResult } = require('express-validator');
const passport = require('passport');
const debug = require('debug');
const authConfig = require('../../config/auth.config.js');
const {
  isProviderReady,
  getReadyProvider,
  getStrategy,
  listEnabledProviders,
  strategyName,
} = require('../utils/passport-setup.js');

const log = debug('auth:routes');

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
  //
  // The callback is invoked with an explicit verify callback rather than relying on
  // `failureRedirect`, because a rejected credential can reach us two ways: as a clean
  // failure (`user` is false - the user is not permitted), or as a strategy error (a
  // malformed, unsigned, expired or forged assertion). Passport routes the latter to the
  // error handler, which would surface a bare 500 with a stack trace to someone who just
  // failed to log in. Both are the same thing from the user's perspective, so both land
  // on the login page, and the reason is logged rather than returned.
  const ssoCallback = (req, res, next) => {
    const { providerId } = req.params;
    return passport.authenticate(strategyName(providerId), (err, user, info) => {
      if (err) {
        log('SSO callback for provider %s failed: %s', providerId, err.message);
        return res.redirect('/login?error=true');
      }
      if (!user) {
        log('SSO callback for provider %s denied: %s', providerId, (info && info.message) || 'no user');
        return res.redirect('/login?error=true');
      }
      return req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        // Successful authentication, redirect home.
        return res.redirect('/');
      });
    })(req, res, next);
  };

  app.get(`${path}/auth/sso/:providerId/callback`, ssoGuard, ssoCallback);

  // SAML posts the assertion back to the ACS endpoint as a form body rather than
  // returning via a redirect, so the same callback path must also accept POST.
  app.post(`${path}/auth/sso/:providerId/callback`, ssoGuard, ssoCallback);

  // SP metadata. IdP administrators generally want an XML document to import rather than
  // transcribing the entity id and ACS URL by hand.
  app.get(`${path}/auth/sso/:providerId/metadata`, ssoGuard, (req, res) => {
    const provider = req.ssoProvider;
    if (provider.type !== 'saml') {
      return res.status(404).json({ error: 'Metadata is only available for SAML providers.' });
    }
    const strategy = getStrategy(provider.id);
    res.type('application/xml');
    // No decryption or signing certificate: Angles neither encrypts assertions nor signs
    // AuthnRequests by default, so the SP metadata advertises neither.
    return res.send(strategy.generateServiceProviderMetadata(null, null));
  });

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

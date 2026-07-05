const { check, validationResult } = require('express-validator');
const passport = require('passport');
const authConfig = require('../../config/auth.config');

module.exports = (app, path) => {
  // Config
  app.get(`${path}/auth/config`, (req, res) => {
    res.json({
      localAuthEnabled: true,
      oktaAuthEnabled: authConfig.authType === 'okta'
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

  // Okta Authentication (only register if configured)
  if (authConfig.authType === 'okta') {
    app.get(`${path}/auth/okta`, passport.authenticate('oidc'));
    
    app.get(`${path}/auth/okta/callback`, 
      passport.authenticate('oidc', { failureRedirect: '/login?error=true' }),
      (req, res) => {
        // Successful authentication, redirect home or send response
        res.redirect('/');
      }
    );
  }

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

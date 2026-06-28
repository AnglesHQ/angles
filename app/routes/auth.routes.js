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
  app.post(`${path}/auth/login`, (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ error: info.message || 'Login failed' });
      }
      req.logIn(user, (err) => {
        if (err) return next(err);
        return res.json({ message: 'Logged in successfully', user: { username: user.username, role: user.role, teams: user.teams } });
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

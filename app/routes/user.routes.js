const { check, param } = require('express-validator');
const users = require('../controllers/user.controller');
const authMiddleware = require('../utils/auth-middleware');

module.exports = (app, path) => {
  // Prevent token auth for all user routes
  app.use(`${path}/users`, authMiddleware.preventTokenAuth);

  // Token management routes (users can manage their own tokens)
  app.post(`${path}/users/:userId/tokens`, [
    param('userId').isMongoId(),
    check('name')
      .exists({ checkFalsy: true })
      .withMessage('Token name is mandatory')
      .isLength({ min: 1, max: 100 })
      .withMessage('Token name must be between 1 and 100 characters.'),
    check('expiresInDays')
      .exists({ checkFalsy: true })
      .isInt({ min: 1, max: 365 })
      .withMessage('expiresInDays must be an integer between 1 and 365.'),
  ], authMiddleware.isAuthenticated, users.generateToken);

  app.get(`${path}/users/:userId/tokens`, [
    param('userId').isMongoId(),
  ], authMiddleware.isAuthenticated, users.getTokens);

  app.delete(`${path}/users/:userId/tokens/:tokenId`, [
    param('userId').isMongoId(),
    param('tokenId').isMongoId(),
  ], authMiddleware.isAuthenticated, users.revokeToken);

  // Admin-only user management routes
  app.use(`${path}/users`, authMiddleware.authorizeAdmin);

  app.post(`${path}/users`, [
    check('username')
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9-_]{2,50}$/)
      .withMessage('Username must only contain letters, numbers, hyphens or underscores (2–50 characters).'),
    check('password')
      .optional()
      .isLength({ min: 8, max: 100 })
      .withMessage('Password must be between 8 and 100 characters.'),
    check('role')
      .optional()
      .isIn(['admin', 'user', 'team_lead'])
      .withMessage('Role must be one of: admin, user, team_lead.'),
    check('authProvider')
      .optional()
      .isIn(['local', 'okta'])
      .withMessage('authProvider must be one of: local, okta.'),
    check('teams')
      .optional()
      .isArray()
      .withMessage('teams must be an array.'),
  ], users.create);

  app.get(`${path}/users`, users.findAll);

  app.get(`${path}/users/:userId`, [
    param('userId').isMongoId(),
  ], users.findOne);

  app.put(`${path}/users/:userId`, [
    param('userId').isMongoId(),
    check('role')
      .optional()
      .isIn(['admin', 'user', 'team_lead'])
      .withMessage('Role must be one of: admin, user, team_lead.'),
    check('password')
      .optional()
      .isLength({ min: 8, max: 100 })
      .withMessage('Password must be between 8 and 100 characters.'),
    check('teams')
      .optional()
      .isArray()
      .withMessage('teams must be an array.'),
  ], users.update);

  app.delete(`${path}/users/:userId`, [
    param('userId').isMongoId(),
  ], users.delete);
};

const { check } = require('express-validator');
const settings = require('../controllers/settings.controller.js');
const authMiddleware = require('../utils/auth-middleware.js');

module.exports = (app, path) => {
  // Settings are admin-only and cannot be managed with an API token.
  app.use(`${path}/settings`, authMiddleware.preventTokenAuth);

  app.get(
    `${path}/settings/auth`,
    authMiddleware.isAuthenticated,
    authMiddleware.authorizeAdmin,
    settings.getAuthSettings,
  );

  app.put(`${path}/settings/auth`, [
    check('localAuthEnabled').optional().isBoolean().withMessage('localAuthEnabled must be a boolean.'),
    check('oktaAuthEnabled').optional().isBoolean().withMessage('oktaAuthEnabled must be a boolean.'),
    check('oktaDomain').optional({ nullable: true }).isString().isLength({ max: 255 }),
    check('oktaClientId').optional({ nullable: true }).isString().isLength({ max: 255 }),
    check('oktaClientSecret').optional({ nullable: true }).isString().isLength({ max: 500 }),
    check('oktaIssuer').optional({ nullable: true }).isString().isLength({ max: 255 }),
    check('oktaAdminGroup').optional({ nullable: true }).isString().isLength({ max: 255 }),
    check('oktaTeamLeadGroup').optional({ nullable: true }).isString().isLength({ max: 255 }),
    check('oktaUserGroup').optional({ nullable: true }).isString().isLength({ max: 255 }),
  ], authMiddleware.isAuthenticated, authMiddleware.authorizeAdmin, settings.updateAuthSettings);
};

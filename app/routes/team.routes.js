const { check, param, query } = require('express-validator');
const teamController = require('../controllers/team.controller.js');
const authMiddleware = require('../utils/auth-middleware.js');

// What a username can contain when it is looked up for team membership. Local accounts are
// letters, digits, hyphens and underscores, but accounts created by a single sign-on login
// take the identifier the provider reports, which is often an email address.
const USERNAME_CHARACTERS = /^[A-Za-z0-9._@+-]+$/;

module.exports = (app, path) => {
  app.post(`${path}/team`, authMiddleware.authorizeAdmin, [
    check('name')
      .exists()
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9-]{2,50}$/)
      .withMessage('Name must only contain letters, numbers and hyphens (and be between 2 and 50 characters).'),
    check('components')
      .exists()
      .custom((componentArray) => Array.isArray(componentArray) && componentArray.length > 0)
      .withMessage('At least one component is required'),
    check('components.*.name')
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9-]{2,50}$/)
      .withMessage('Component name must only contain letters, numbers and hyphens (and be between 2 and 50 characters).'),
  ], teamController.create);

  app.get(`${path}/team`, teamController.findAll);

  app.get(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.findOne);

  app.put(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
    check('name')
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9-]{2,50}$/)
      .withMessage('Name must only contain letters, numbers and hyphens (and be between 2 and 50 characters).'),
  ], teamController.update);

  app.put(`${path}/team/:teamId/components`, [
    param('teamId').isMongoId(),
    check('components')
      .exists()
      .custom((componentArray) => Array.isArray(componentArray) && componentArray.length > 0)
      .withMessage('At least one component is required'),
    check('components.*')
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9-]{2,50}$/)
      .withMessage('Component name must only contain letters, numbers and hyphens (and be between 2 and 50 characters).'),
  ], teamController.addComponents);

  // Team membership. Managed from a session only (not an API token), like the user routes:
  // who may see a team is not something a CI key should be able to change. The controller
  // restricts the callers to admins and the team's own leads.
  app.get(`${path}/team/:teamId/members`, authMiddleware.preventTokenAuth, [
    param('teamId').isMongoId(),
  ], teamController.getMembers);

  // Predictive search for the "add member" box. Deliberately narrow, because it lets a team
  // lead look up accounts they otherwise cannot list: it needs at least three characters of
  // the username and returns a handful of matches, never the core admin account or people
  // already in the team.
  app.get(`${path}/team/:teamId/members/candidates`, authMiddleware.preventTokenAuth, [
    param('teamId').isMongoId(),
    query('q')
      .exists({ checkFalsy: true })
      .isString()
      .trim()
      .isLength({ min: 3, max: 254 })
      .withMessage('q must be between 3 and 254 characters.')
      .matches(USERNAME_CHARACTERS)
      .withMessage('q must only contain letters, numbers and . _ @ + - characters.'),
  ], teamController.searchMemberCandidates);

  app.post(`${path}/team/:teamId/members`, authMiddleware.preventTokenAuth, [
    param('teamId').isMongoId(),
    check('username')
      .exists({ checkFalsy: true })
      .isString()
      .isLength({ min: 2, max: 254 })
      .matches(USERNAME_CHARACTERS)
      .withMessage('Username must be 2 to 254 characters: letters, numbers and . _ @ + - only.'),
  ], teamController.addMember);

  app.delete(`${path}/team/:teamId/members/:userId`, authMiddleware.preventTokenAuth, [
    param('teamId').isMongoId(),
    param('userId').isMongoId(),
  ], teamController.removeMember);

  app.delete(`${path}/team/:teamId`, authMiddleware.authorizeAdmin, [
    param('teamId').isMongoId(),
  ], teamController.delete);
};

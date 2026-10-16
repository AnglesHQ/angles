const { check, param } = require('express-validator');
const teamController = require('../controllers/team.controller.js');
const authMiddleware = require('../utils/auth-middleware.js');

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

  app.post(`${path}/team/:teamId/members`, authMiddleware.preventTokenAuth, [
    param('teamId').isMongoId(),
    check('username')
      .exists({ checkFalsy: true })
      .isString()
      .matches(/^[A-Za-z0-9-_]{2,50}$/)
      .withMessage('Username must only contain letters, numbers, hyphens or underscores (2–50 characters).'),
  ], teamController.addMember);

  app.delete(`${path}/team/:teamId/members/:userId`, authMiddleware.preventTokenAuth, [
    param('teamId').isMongoId(),
    param('userId').isMongoId(),
  ], teamController.removeMember);

  app.delete(`${path}/team/:teamId`, authMiddleware.authorizeAdmin, [
    param('teamId').isMongoId(),
  ], teamController.delete);
};

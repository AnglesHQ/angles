const { check, param } = require('express-validator');
const teamController = require('../controllers/team.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/team`, [
    check('name')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for team name is 50 characters'),
    check('components')
      .exists()
      .custom((componentArray) => Array.isArray(componentArray) && componentArray.length > 0)
      .withMessage('At least one component is required'),
    check('components.*.name')
      .exists()
      .isAlphanumeric(),
    check('components.*.features')
      .optional()
      .isArray()
      .withMessage('Features field has to be an Array'),
  ], teamController.create);

  app.get(`${path}/team`, teamController.findAll);

  app.get(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.findOne);

  app.put(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
    check('name')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for team name is 50 characters'),
  ], teamController.update);

  app.put(`${path}/team/:teamId/components`, [
    param('teamId').isMongoId(),
    check('components')
      .exists()
      .custom((componentArray) => Array.isArray(componentArray) && componentArray.length > 0)
      .withMessage('At least one component is required'),
  ], teamController.addComponents);

  app.delete(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.delete);
};

const { check, param } = require('express-validator');
const teamController = require('../controllers/team.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/team`, [
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

  app.delete(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.delete);
};

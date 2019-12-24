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
      .isArray()
      .withMessage('Components field has to be an Array'),
    check('components.*.name')
      .exists()
      .isAlphanumeric(),
    check('components.*.features')
      .isArray()
      .withMessage('Features field has to be an Array'),
  ], teamController.create);

  app.get(`${path}/team`, teamController.findAll);

  app.get(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.findOne);

  app.put(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.update);

  app.delete(`${path}/team/:teamId`, [
    param('teamId').isMongoId(),
  ], teamController.delete);
};

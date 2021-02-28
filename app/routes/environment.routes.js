const { check, param } = require('express-validator');
const environmentController = require('../controllers/environment.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/environment`, [
    check('name')
      .exists()
      .isLength({ max: 30 })
      .withMessage('Max length for environment name is 30 characters')
      .matches(/^[A-Za-z0-9-]+$/)
      .withMessage('Name must only contain letters, numbers and hyphens.'),
  ], environmentController.create);

  app.get(`${path}/environment`, environmentController.findAll);

  app.get(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
  ], environmentController.findOne);

  app.put(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
    check('name')
      .exists()
      .isLength({ max: 50 })
      .withMessage('Max length for environment name is 50 characters')
      .matches(/^[A-Za-z0-9-]+$/)
      .withMessage('Name must only contain letters, numbers and hyphens.'),
  ], environmentController.update);

  app.delete(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
  ], environmentController.delete);
};

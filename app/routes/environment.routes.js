const { check, param } = require('express-validator');
const environmentController = require('../controllers/environment.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/environment`, [
    check('name').exists(),
    check('name').isString(),
    check('name').isLength({ max: 50 })
      .withMessage('Max length for environment name is 50 characters'),
  ], environmentController.create);

  app.get(`${path}/environment`, environmentController.findAll);

  app.get(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
  ], environmentController.findOne);

  app.put(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
    check('name').exists(),
    check('name').isString(),
  ], environmentController.update);

  app.delete(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
  ], environmentController.delete);
};

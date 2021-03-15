const { check, param } = require('express-validator');
const environmentController = require('../controllers/environment.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/environment`, [
    check('name')
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9\-\s]{2,50}$/)
      .withMessage('Name must only contain letters, numbers and hyphens (and be between 2 and 50 characters).'),
  ], environmentController.create);

  app.get(`${path}/environment`, environmentController.findAll);

  app.get(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
  ], environmentController.findOne);

  app.put(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
    check('name')
      .exists({ checkFalsy: true })
      .matches(/^[A-Za-z0-9\-\s]{2,50}$/)
      .withMessage('Name must only contain letters, numbers and hyphens (and be between 2 and 50 characters).'),
  ], environmentController.update);

  app.delete(`${path}/environment/:environmentId`, [
    param('environmentId').isMongoId(),
  ], environmentController.delete);
};

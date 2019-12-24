const { check, param } = require('express-validator');
const buildController = require('../controllers/build.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/build`, [
    // username must be an email
    check('environment').exists(),
    check('environment').isString(),
    check('team').exists(),
    check('team').isString(),
    check('name').exists(),
    check('name').isString(),
    check('name').isLength({ max: 50 })
      .withMessage('Max length for build name is 50 characters'),
    check('component').exists(),
    check('component').isString(),
    check('component').isLength({ max: 50 })
      .withMessage('Max length for component name is 50 characters'),
  ], buildController.create);

  app.get(`${path}/build`, buildController.findAll);

  app.get(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
  ], buildController.findOne);

  app.put(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
    check('environment').exists(),
    check('environment').isString(),
    check('team').exists(),
    check('team').isString(),
  ], buildController.update);

  app.put(`${path}/build/:buildId/keep`, [
    param('buildId').isMongoId(),
    check('keep').exists(),
    check('keep').isBoolean(),
  ], buildController.setKeep);

  app.delete(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
  ], buildController.delete);
};

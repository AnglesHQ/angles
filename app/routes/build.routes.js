const { check, param } = require('express-validator');
const buildController = require('../controllers/build.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/build`, [
    // username must be an email
    check('environment')
      .exists()
      .isString(),
    check('team')
      .exists()
      .isString(),
    check('name')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for build name is 50 characters'),
    check('component')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for component name is 50 characters'),
  ], buildController.create);

  app.get(`${path}/build`, buildController.findAll);

  app.get(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
  ], buildController.findOne);

  app.put(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
    check('environment')
      .exists()
      .isString(),
    check('team')
      .exists()
      .isString(),
  ], buildController.update);

  app.put(`${path}/build/:buildId/keep`, [
    param('buildId').isMongoId(),
    check('keep')
      .exists()
      .isBoolean(),
  ], buildController.setKeep);

  app.put(`${path}/build/:buildId/artifacts`, [
    param('buildId').isMongoId(),
    check('artifacts')
      .exists()
      .custom((artifactsArray) => Array.isArray(artifactsArray) && artifactsArray.length > 0)
      .withMessage('At least one artifact is required'),
    check('artifacts.*.groupId')
      .exists()
      .isString()
      .trim(),
    check('artifacts.*.artifactId')
      .exists()
      .isString()
      .trim(),
    check('artifacts.*.version')
      .exists()
      .isString()
      .trim(),
  ], buildController.setArtifacts);

  app.delete(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
  ], buildController.delete);
};

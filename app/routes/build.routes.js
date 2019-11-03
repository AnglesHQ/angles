const { check } = require('express-validator');
const buildController = require('../controllers/build.controller.js');

module.exports = (app, path) => {
  // Create a new build
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

  // Retrieve all builds
  app.get(`${path}/build`, buildController.findAll);

  // Retrieve a single build with buildId
  app.get(`${path}/build/:buildId`, buildController.findOne);

  // Update a build with buildId
  app.put(`${path}/build/:buildId`, [
    // username must be an email
    check('environment').exists(),
    check('environment').isString(),
    check('team').exists(),
    check('team').isString(),
  ], buildController.update);

  // Update a build with buildId
  app.put(`${path}/build/:buildId/updateKeep`, [
    // username must be an email
    check('keep').exists(),
    check('keep').isBoolean(),
  ], buildController.updateKeep);

  // Delete a build with buildId
  app.delete(`${path}/build/:buildId`, buildController.delete);
};

module.exports = (app, path) => {
  const buildController = require('../controllers/build.controller.js');
  const { check, validationResult } = require('express-validator');

  // Create a new build
  app.post(path + '/build', [
      // username must be an email
      check('environment').exists(),
      check('environment').isString(),
      check('team').exists(),
      check('team').isString()
    ], buildController.create);

  // Retrieve all builds
  app.get(path + '/build', buildController.findAll);

  // Retrieve a single build with buildId
  app.get(path + '/build/:buildId', buildController.findOne);

  // Update a build with buildId
  app.put(path + '/build/:buildId', [
      // username must be an email
      check('environment').exists(),
      check('environment').isString(),
      check('team').exists(),
      check('team').isString()
    ], buildController.update);

  // Delete a build with buildId
  app.delete(path + '/build/:buildId', buildController.delete);
}

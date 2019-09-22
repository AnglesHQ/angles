module.exports = (app) => {
  const buildController = require('../controllers/build.controller.js');
  const { check, validationResult } = require('express-validator');

  // Create a new build
  app.post('/build', [
      // username must be an email
      check('environment').exists(),
      check('environment').isString(),
      check('team').exists(),
      check('team').isString()
    ], buildController.create);

  // Retrieve all builds
  app.get('/build', buildController.findAll);

  // Retrieve a single build with buildId
  app.get('/build/:buildId', buildController.findOne);

  // Update a build with buildId
  // app.put('/build/:buildId', buildController.update);

  // Delete a build with buildId
  app.delete('/build/:buildId', buildController.delete);
}

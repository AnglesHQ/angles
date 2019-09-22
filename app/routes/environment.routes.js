module.exports = (app) => {
  const environmentController = require('../controllers/environment.controller.js');
  const { check, validationResult } = require('express-validator');

  // Create a new environment
  app.post('/environment', [
      check('name').exists(),
      check('name').isString()
    ], environmentController.create);

  // Retrieve all environments
  app.get('/environment', environmentController.findAll);

  // Retrieve a single environment with environmentId
  app.get('/environment/:environmentId', environmentController.findOne);

  //Update a environment with environmentId
  // app.put('/environment/:environmentId', environmentController.update);

  // Delete a environment with environmentId
  app.delete('/environment/:environmentId', environmentController.delete);
}

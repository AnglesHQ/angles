module.exports = (app, path) => {
  const environmentController = require('../controllers/environment.controller.js');
  const { check, validationResult } = require('express-validator');

  // Create a new environment
  app.post(path + '/environment', [
      check('name').exists(),
      check('name').isString(),
      check('name').isLength({ max: 50 })
      .withMessage('Max length for environment name is 50 characters')
    ], environmentController.create);

  // Retrieve all environments
  app.get(path + '/environment', environmentController.findAll);

  // Retrieve a single environment with environmentId
  app.get(path + '/environment/:environmentId', environmentController.findOne);

  //Update a environment with environmentId
  app.put(path + '/environment/:environmentId', [
      check('name').exists(),
      check('name').isString()
    ], environmentController.update);

  // Delete a environment with environmentId
  app.delete(path + '/environment/:environmentId', environmentController.delete);
}

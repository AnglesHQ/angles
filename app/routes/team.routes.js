module.exports = (app, path) => {
  const teamController = require('../controllers/team.controller.js');
  const { check, validationResult } = require('express-validator');

  // Create a new team
  app.post(path + '/team', [
      check('name').exists(),
      check('name').isString(),
    ], teamController.create);

  // Retrieve all teams
  app.get(path + '/team', teamController.findAll);

  // Retrieve a single team with teamId
  app.get(path + '/team/:teamId', teamController.findOne);

  // Update a team with teamId
  app.put(path + '/team/:teamId', teamController.update);

  // Delete a team with teamId
  app.delete(path + '/team/:teamId', teamController.delete);
}

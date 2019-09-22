module.exports = (app) => {
  const teamController = require('../controllers/team.controller.js');
  const { check, validationResult } = require('express-validator');

  // Create a new team
  app.post('/team', [
      check('name').exists(),
      check('name').isString(),
    ], teamController.create);

  // Retrieve all teams
  app.get('/team', teamController.findAll);

  // Retrieve a single team with teamId
  app.get('/team/:teamId', teamController.findOne);

  // Update a team with teamId
  // app.put('/team/:teamId', teamController.update);

  // Delete a team with teamId
  app.delete('/team/:teamId', teamController.delete);
}

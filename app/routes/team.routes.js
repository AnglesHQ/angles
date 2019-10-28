const { check } = require('express-validator');
const teamController = require('../controllers/team.controller.js');

module.exports = (app, path) => {
  // Create a new team
  app.post(`${path}/team`, [
    check('name').exists(),
    check('name').isString(),
    check('name').isLength({ max: 50 })
      .withMessage('Max length for team name is 50 characters'),
  ], teamController.create);

  // Retrieve all teams
  app.get(`${path}/team`, teamController.findAll);

  // Retrieve a single team with teamId
  app.get(`${path}/team/:teamId`, teamController.findOne);

  // Update a team with teamId
  app.put(`${path}/team/:teamId`, teamController.update);

  // Delete a team with teamId
  app.delete(`${path}/team/:teamId`, teamController.delete);
};

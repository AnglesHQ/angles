const { check } = require('express-validator');
const teamController = require('../controllers/team.controller.js');

module.exports = (app, path) => {
  // Create a new team
  app.post(`${path}/team`, [
    check('name')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for team name is 50 characters'),
    check('components')
      .exists()
      .isArray()
      .withMessage('Components field has to be an Array'),
    check('components.*.name')
      .exists()
      .isAlphanumeric(),
    check('components.*.features')
      .isArray()
      .withMessage('Features field has to be an Array'),
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

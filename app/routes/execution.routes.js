const { check } = require('express-validator');
const executionController = require('../controllers/execution.controller.js');

module.exports = (app, path) => {
  // Create a new team
  app.post(`${path}/execution`, [
    check('title').exists(),
    check('title').isString(),
    check('title').isLength({ max: 150 })
      .withMessage('Max length for test title is 150 characters'),
    check('suite').exists(),
    check('suite').isString(),
    check('suite').isLength({ max: 150 })
      .withMessage('Max length for suite name is 150 characters'),
    check('build').exists(),
    check('build').isString(),
    check('start').exists(),
    check('start').isISO8601(),
  ], executionController.create);

  // Retrieve all teams
  app.get(`${path}/execution`, executionController.findAll);

  // Retrieve a single execution with executionId
  app.get(`${path}/execution/:executionId`, executionController.findOne);

  // Update a team with teamId
  app.put(`${path}/execution/:executionId`, executionController.update);

  // Delete a team with teamId
  app.delete(`${path}/execution/:executionId`, executionController.delete);
};

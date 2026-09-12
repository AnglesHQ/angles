const { check, param, query } = require('express-validator');
const sharedStepController = require('../controllers/shared-step.controller.js');
const featureMiddleware = require('../utils/feature-middleware.js');

// Shared by create and update. A shared step's steps are literal, so `sharedStep` is not
// accepted on them - the controller rejects any that slip through with an explanatory 400.
const stepValidators = [
  check('description')
    .optional()
    .isString()
    .isLength({ max: 5000 })
    .withMessage('Max length for the description is 5000 characters'),
  check('steps')
    .optional()
    .isArray(),
  check('steps.*.action')
    .exists()
    .isString()
    .isLength({ max: 2000 })
    .withMessage('Each step requires an action (max 2000 characters)'),
  check('steps.*.expected')
    .optional()
    .isString()
    .isLength({ max: 2000 })
    .withMessage('Max length for a step expected result is 2000 characters'),
  check('steps.*.data')
    .optional()
    .isString()
    .isLength({ max: 2000 })
    .withMessage('Max length for step data is 2000 characters'),
  check('steps.*.order')
    .optional()
    .isNumeric(),
  // Optional free-text reason, recorded against the change history entry.
  check('comment')
    .optional()
    .isString()
    .isLength({ max: 500 })
    .withMessage('Max length for a change comment is 500 characters'),
];

module.exports = (app, path) => {
  // Manual testing is an optional feature; when an admin has turned it off every
  // route below responds 404, so the data is unreachable and not merely hidden in the UI.
  app.use(`${path}/shared-step`, featureMiddleware.requireManualTesting);
  app.post(`${path}/shared-step`, [
    check('team')
      .exists()
      .isMongoId(),
    check('name')
      .exists({ checkFalsy: true })
      .isString()
      .isLength({ min: 1, max: 150 })
      .withMessage('Max length for a shared step name is 150 characters'),
    check('steps')
      .exists()
      .custom((steps) => Array.isArray(steps) && steps.length > 0)
      .withMessage('At least one step is required'),
    ...stepValidators,
  ], sharedStepController.create);

  app.get(`${path}/shared-step`, [
    query('teamId')
      .exists()
      .isMongoId(),
    // Interpolated into a $regex in the controller (escaped there), so bound the length
    // here rather than leaving it entirely unvalidated.
    query('search')
      .optional()
      .isString()
      .isLength({ max: 100 }),
    query('limit')
      .optional()
      .isNumeric(),
    query('skip')
      .optional()
      .isNumeric(),
  ], sharedStepController.findAll);

  app.get(`${path}/shared-step/:sharedStepId`, [
    param('sharedStepId')
      .exists()
      .isMongoId(),
  ], sharedStepController.findOne);

  app.get(`${path}/shared-step/:sharedStepId/usage`, [
    param('sharedStepId')
      .exists()
      .isMongoId(),
  ], sharedStepController.findUsage);

  app.get(`${path}/shared-step/:sharedStepId/history`, [
    param('sharedStepId')
      .exists()
      .isMongoId(),
    query('limit')
      .optional()
      .isNumeric(),
    query('skip')
      .optional()
      .isNumeric(),
  ], sharedStepController.findHistory);

  app.put(`${path}/shared-step/:sharedStepId`, [
    param('sharedStepId')
      .exists()
      .isMongoId(),
    check('name')
      .optional()
      .isString()
      .isLength({ min: 1, max: 150 })
      .withMessage('Max length for a shared step name is 150 characters'),
    ...stepValidators,
  ], sharedStepController.update);

  app.delete(`${path}/shared-step/:sharedStepId`, [
    param('sharedStepId')
      .exists()
      .isMongoId(),
    check('comment')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Max length for a change comment is 500 characters'),
  ], sharedStepController.delete);
};

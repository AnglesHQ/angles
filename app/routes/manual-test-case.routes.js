const { check, param, query } = require('express-validator');
const manualTestCaseController = require('../controllers/manual-test-case.controller.js');
const featureMiddleware = require('../utils/feature-middleware.js');
const {
  testCaseStates,
  testCasePriorities,
} = require('../models/manual-test-case.js');

// Shared by POST and PUT. Every field except the title is optional on create (a case
// starts as a draft and is filled in progressively), and all of them are optional on
// update - an omitted field is left untouched rather than cleared.
// Turns an express-validator path like "steps[2].action" into "Step 3", so a message can
// say which step is wrong rather than leaving the author to count.
const describeStep = (validatorPath) => {
  const match = /steps\[(\d+)\]/.exec(validatorPath || '');
  return match ? `Step ${Number(match[1]) + 1}` : 'Each step';
};

const contentValidators = [
  check('description')
    .optional()
    .isString()
    .isLength({ max: 5000 })
    .withMessage('Max length for the description is 5000 characters'),
  check('preconditions')
    .optional()
    .isString()
    .isLength({ max: 5000 })
    .withMessage('Max length for the preconditions is 5000 characters'),
  check('status')
    .optional()
    .isIn(testCaseStates)
    .withMessage(`Status must be one of [${testCaseStates.join(', ')}]`),
  check('priority')
    .optional()
    .isIn(testCasePriorities)
    .withMessage(`Priority must be one of [${testCasePriorities.join(', ')}]`),
  check('tags')
    .optional()
    .isArray(),
  check('tags.*')
    .optional()
    .isString()
    .isLength({ max: 50 })
    .withMessage('Max length for a tag is 50 characters'),
  check('steps')
    .optional()
    .isArray(),
  // A shared step inclusion has no action of its own - the shared step's contents are
  // expanded in its place - so the action is only required for a literal step.
  check('steps.*.action')
    .if((value, { req, path }) => {
      const index = path.match(/steps\[(\d+)\]/);
      const step = index && req.body.steps ? req.body.steps[Number(index[1])] : undefined;
      // Two shapes carry no action of their own and must both be exempt:
      //   sharedStep    - an inclusion the author just added; the shared step's contents
      //                   are expanded in its place.
      //   sharedStepRef - a step that came *from* a shared step, echoed back by a client
      //                   that read the case and is now saving it. Its action is whatever
      //                   the shared step said, which may legitimately be empty.
      return !(step && (step.sharedStep || step.sharedStepRef));
    })
    // Each check carries its own message and names the step. withMessage() only applies to
    // the validator immediately before it, so a shared trailing message would leave the
    // others reporting a bare "Invalid value" - which tells the author nothing about which
    // of several steps is wrong.
    .exists()
    .withMessage((value, { path }) => `${describeStep(path)} requires an action, unless it includes a shared step`)
    .bail()
    .isString()
    .withMessage((value, { path }) => `${describeStep(path)} action must be text`)
    .bail()
    .isLength({ max: 2000 })
    .withMessage((value, { path }) => `${describeStep(path)} action must be 2000 characters or fewer`),
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
  // null or absent files the case at the team root.
  check('folder')
    .optional({ nullable: true })
    .isMongoId(),
  check('customFields')
    .optional()
    .isObject()
    .withMessage('customFields must be an object of field key to value'),
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
  app.use(`${path}/manual-test-case`, featureMiddleware.requireManualTesting);
  app.post(`${path}/manual-test-case`, [
    check('team')
      .exists()
      .isMongoId(),
    check('component')
      .optional()
      .isMongoId(),
    check('title')
      .exists({ checkFalsy: true })
      .isString()
      .isLength({ max: 200 })
      .withMessage('Max length for the test case title is 200 characters'),
    ...contentValidators,
  ], manualTestCaseController.create);

  app.get(`${path}/manual-test-case`, [
    // A folder id narrows to that folder; the literal "none" narrows to unfiled cases.
    query('folder')
      .optional()
      .custom((value) => value === 'none' || /^[a-f\d]{24}$/i.test(value))
      .withMessage('folder must be a valid id, or "none" for unfiled test cases'),
    query('includeSubFolders')
      .optional()
      .isBoolean(),
    query('teamId')
      .exists()
      .isMongoId(),
    query('status')
      .optional()
      .isString(),
    query('priority')
      .optional()
      .isString(),
    query('tags')
      .optional()
      .isString(),
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
  ], manualTestCaseController.findAll);

  app.get(`${path}/manual-test-case/:caseId`, [
    param('caseId')
      .exists()
      .isMongoId(),
  ], manualTestCaseController.findOne);

  app.get(`${path}/manual-test-case/:caseId/history`, [
    param('caseId')
      .exists()
      .isMongoId(),
    query('limit')
      .optional()
      .isNumeric(),
    query('skip')
      .optional()
      .isNumeric(),
  ], manualTestCaseController.findHistory);

  app.get(`${path}/manual-test-case/:caseId/version`, [
    param('caseId')
      .exists()
      .isMongoId(),
  ], manualTestCaseController.findVersions);

  app.get(`${path}/manual-test-case/:caseId/version/:version`, [
    param('caseId')
      .exists()
      .isMongoId(),
    param('version')
      .exists()
      .isInt({ min: 1 }),
  ], manualTestCaseController.findVersion);

  app.put(`${path}/manual-test-case/:caseId`, [
    param('caseId')
      .exists()
      .isMongoId(),
    check('component')
      .optional()
      .isMongoId(),
    check('title')
      .optional()
      .isString()
      .isLength({ min: 1, max: 200 })
      .withMessage('Max length for the test case title is 200 characters'),
    ...contentValidators,
  ], manualTestCaseController.update);

  app.post(`${path}/manual-test-case/:caseId/clone`, [
    param('caseId')
      .exists()
      .isMongoId(),
    check('title')
      .optional()
      .isString()
      .isLength({ min: 1, max: 200 })
      .withMessage('Max length for the test case title is 200 characters'),
    check('comment')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Max length for a change comment is 500 characters'),
  ], manualTestCaseController.clone);

  app.delete(`${path}/manual-test-case/:caseId`, [
    param('caseId')
      .exists()
      .isMongoId(),
    check('comment')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Max length for a change comment is 500 characters'),
  ], manualTestCaseController.delete);
};

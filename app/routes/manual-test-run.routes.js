const { check, param, query } = require('express-validator');
const manualTestRunController = require('../controllers/manual-test-run.controller.js');
const { runStates, caseResultStates } = require('../models/manual-test-run.js');

const platformValidators = [
  check('platforms').optional().isArray(),
  check('platforms.*.platformName').optional().isString(),
  check('platforms.*.platformVersion').optional().isString(),
  check('platforms.*.browserName').optional().isString(),
  check('platforms.*.browserVersion').optional().isString(),
  check('platforms.*.deviceName').optional().isString(),
  check('platforms.*.userAgent').optional().isString(),
  check('platforms.*.screenHeight').optional().isNumeric(),
  check('platforms.*.screenWidth').optional().isNumeric(),
  check('platforms.*.pixelRatio').optional().isNumeric(),
];

module.exports = (app, path) => {
  app.post(`${path}/manual-test-run`, [
    check('name')
      .exists({ checkFalsy: true })
      .isString()
      .isLength({ max: 200 })
      .withMessage('Max length for a test run name is 200 characters'),
    check('description').optional().isString().isLength({ max: 5000 }),
    check('team').exists().isMongoId(),
    check('component').optional().isMongoId(),
    check('environment').exists().isString(),
    check('phase').optional().isString(),
    check('assignedTo').optional().isMongoId(),
    check('testCaseIds').optional().isArray(),
    check('testCaseIds.*').optional().isMongoId(),
    ...platformValidators,
  ], manualTestRunController.create);

  app.get(`${path}/manual-test-run`, [
    query('teamId').exists().isMongoId(),
    query('status').optional().isString(),
    query('assignedTo').optional().isMongoId(),
    query('limit').optional().isNumeric(),
    query('skip').optional().isNumeric(),
  ], manualTestRunController.findAll);

  app.get(`${path}/manual-test-run/:runId`, [
    param('runId').exists().isMongoId(),
    query('expand').optional().isBoolean(),
  ], manualTestRunController.findOne);

  app.put(`${path}/manual-test-run/:runId`, [
    param('runId').exists().isMongoId(),
    check('name').optional().isString().isLength({ min: 1, max: 200 }),
    check('description').optional().isString().isLength({ max: 5000 }),
    check('assignedTo').optional().isMongoId(),
    check('testCaseIds').optional().isArray(),
    check('testCaseIds.*').optional().isMongoId(),
    ...platformValidators,
  ], manualTestRunController.update);

  app.put(`${path}/manual-test-run/:runId/test-case/:caseId/result`, [
    param('runId').exists().isMongoId(),
    param('caseId').exists().isMongoId(),
    check('status')
      .exists()
      .isIn(caseResultStates)
      .withMessage(`Status must be one of [${caseResultStates.join(', ')}]`),
    check('notes').optional().isString().isLength({ max: 5000 }),
    check('stepResults').optional().isArray(),
    check('stepResults.*.stepId').optional().isMongoId(),
    check('stepResults.*.status')
      .optional()
      .isIn(['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'SKIPPED'])
      .withMessage('Step status must be one of [NOT_RUN, PASS, FAIL, BLOCKED, SKIPPED]'),
    check('stepResults.*.actual').optional().isString().isLength({ max: 5000 }),
    check('stepResults.*.notes').optional().isString().isLength({ max: 5000 }),
    check('stepResults.*.attachments').optional().isArray(),
    check('stepResults.*.attachments.*').optional().isMongoId(),
  ], manualTestRunController.recordResult);

  app.put(`${path}/manual-test-run/:runId/test-case/:caseId/rebind`, [
    param('runId').exists().isMongoId(),
    param('caseId').exists().isMongoId(),
  ], manualTestRunController.rebind);

  app.put(`${path}/manual-test-run/:runId/status`, [
    param('runId').exists().isMongoId(),
    check('status')
      .exists()
      .isIn(runStates)
      .withMessage(`Status must be one of [${runStates.join(', ')}]`),
  ], manualTestRunController.updateStatus);

  app.delete(`${path}/manual-test-run/:runId`, [
    param('runId').exists().isMongoId(),
  ], manualTestRunController.delete);
};

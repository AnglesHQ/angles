const { check, param, query } = require('express-validator');
const moment = require('moment');
const buildController = require('../controllers/build.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/build`, [
    // username must be an email
    check('environment')
      .exists()
      .isString(),
    check('team')
      .exists()
      .isString(),
    check('name')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for build name is 50 characters'),
    check('component')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for component name is 50 characters'),
    check('start')
      .exists()
      .isISO8601(),
  ], buildController.create);

  app.get(`${path}/build`, [
    query('teamId')
      .exists()
      .isMongoId(),
    query('buildIds')
      .optional()
      .isString(),
    query('returnExecutionDetails')
      .optional()
      .isBoolean(),
    query('environmentIds')
      .optional()
      .isString(),
    query('componentIds')
      .optional()
      .isString(),
    query('limit')
      .optional()
      .isNumeric(),
    query('skip')
      .optional()
      .isNumeric(),
    query('fromDate')
      .optional()
      .isISO8601()
      .custom((fromDate) => {
        const today = moment()
          .set({ hour: 23, minute: 59, second: 59 })
          .toISOString();
        const from = new Date(fromDate);
        if (today > from) {
          return false;
        }
        return true;
      })
      .withMessage('The fromDate field has to be in the past.'),
    query('toDate')
      .optional()
      .isISO8601()
      .custom((toDate) => {
        const today = moment()
          .set({ hour: 23, minute: 59, second: 59 })
          .toISOString();
        const to = new Date(toDate);
        if (today > to) {
          return false;
        }
        return true;
      })
      .withMessage('The toDate field has to be in the past.')
      .custom((toDate, { req }) => {
        const { fromDate } = req.query;
        const from = new Date(fromDate);
        const to = new Date(toDate);
        if (from > to) {
          return false;
        }
        return true;
      })
      .withMessage('The toDate has to be after the fromDate.'),
  ], buildController.findAll);

  app.get(`${path}/build/:buildId`, [
    param('buildId')
      .exists()
      .isMongoId(),
  ], buildController.findOne);

  app.put(`${path}/build/:buildId`, [
    param('buildId')
      .exists()
      .isMongoId(),
    check('name')
      .optional()
      .isString(),
    check('keep')
      .optional()
      .isBoolean(),
    check('phase')
      .optional()
      .isString(),
    check('artifacts')
      .optional()
      .custom((artifactsArray) => Array.isArray(artifactsArray) && artifactsArray.length > 0)
      .withMessage('At least one artifact is required'),
    check('artifacts.*.groupId')
      .optional()
      .isString()
      .trim(),
    check('artifacts.*.artifactId')
      .optional()
      .isString()
      .trim(),
    check('artifacts.*.version')
      .optional()
      .isString()
      .trim(),
  ], buildController.update);

  app.put(`${path}/build/:buildId/keep`, [
    param('buildId')
      .exists()
      .isMongoId(),
    check('keep')
      .exists()
      .isBoolean(),
  ], buildController.setKeep);

  app.put(`${path}/build/:buildId/artifacts`, [
    param('buildId').isMongoId(),
    check('artifacts')
      .exists()
      .custom((artifactsArray) => Array.isArray(artifactsArray) && artifactsArray.length > 0)
      .withMessage('At least one artifact is required'),
    check('artifacts.*.groupId')
      .exists()
      .isString()
      .trim(),
    check('artifacts.*.artifactId')
      .exists()
      .isString()
      .trim(),
    check('artifacts.*.version')
      .exists()
      .isString()
      .trim(),
  ], buildController.setArtifacts);

  app.delete(`${path}/build/:buildId`, [
    param('buildId').isMongoId(),
  ], buildController.delete);

  app.delete(`${path}/build/`, [
    query('teamId')
      .exists()
      .isMongoId(),
    query('ageInDays')
      .optional()
      .isNumeric(),
  ], buildController.deleteMany);
};

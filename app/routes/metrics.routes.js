const { query } = require('express-validator');
const buildController = require('../controllers/metrics.controller.js');

module.exports = (app, path) => {
  app.get(`${path}/metrics/phase`, [
    query('teamId')
      .exists()
      .isMongoId(),
    query('componentId')
      .optional()
      .isMongoId(),
    query('fromDate')
      .optional()
      .isISO8601()
      .isBefore(new Date().toISOString())
      .withMessage('The fromDate field has to be in the past.'),
    query('toDate')
      .optional()
      .isISO8601()
      .isBefore(new Date().toISOString())
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
  ], buildController.retrieveMetricsPerPhase);
};

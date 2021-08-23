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
      .isBefore(new Date(new Date().setUTCDate(+1)).toISOString())
      .withMessage('The fromDate field has to be in the past.'),
    query('toDate')
      .optional()
      .isISO8601()
      .isBefore(new Date(new Date().setUTCHours(23, 59, 59)).toISOString())
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
    query('groupingPeriod')
      .optional()
      .custom((groupingPeriod) => {
        // eslint-disable-next-line no-restricted-globals
        if (!isNaN(groupingPeriod)) {
          return (groupingPeriod > 0 && groupingPeriod <= 90);
        }
        return ['day', 'week', 'fortnight', 'month', 'year'].includes(groupingPeriod);
      })
      .withMessage('The groupingPeriod has to be a number between 1 and 90, or one of the following values [day, week, fortnight, month, year]'),
  ], buildController.retrieveMetricsPerPhase);
};

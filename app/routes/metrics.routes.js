const { query } = require('express-validator');
const buildController = require('../controllers/metrics.controller.js');

module.exports = (app, path) => {
  app.get(`${path}/metrics/phase`, [
    query('teamId')
      .exists()
      .isMongoId(),
  ], buildController.retrieveMetricsPerPhase);
};

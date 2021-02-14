const { check, param, query } = require('express-validator');

const baselineController = require('../controllers/baseline.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/baseline`, [
    check('screenshotId')
      .exists()
      .isMongoId(),
    check('view')
      .exists()
      .isString(),
    check('ignoreBoxes')
      .optional(),
  ], baselineController.create);

  app.get(`${path}/baseline`, [
    query('view')
      .exists()
      .isString(),
    query('platformName')
      .exists()
      .isString(),
    query('deviceName')
      .optional()
      .isString(),
    query('browserName')
      .optional()
      .isString(),
    query('screenHeight')
      .optional()
      .isNumeric(),
    query('screenWidth')
      .optional()
      .isNumeric(),
  ], baselineController.findAll);

  app.get(`${path}/baseline/:baselineId`, [
    param('baselineId').isMongoId(),
  ], baselineController.findOne);

  app.put(`${path}/baseline/:baselineId`, [
    param('baselineId').isMongoId(),
    check('screenshotId').isMongoId().exists(),
    check('ignoreBoxes')
      .optional(),
  ], baselineController.update);

  app.delete(`${path}/baseline/:baselineId`, [
    param('baselineId').isMongoId(),
  ], baselineController.delete);
};

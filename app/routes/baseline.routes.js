const { check, param } = require('express-validator');

const baselineController = require('../controllers/baseline.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/baseline`, [
    check('screenshotId')
      .exists()
      .isMongoId(),
    check('view')
      .exists()
      .isString(),
    check('deviceName')
      .exists()
      .isString(),
    check('ignoreBoxes')
      .optional(),
  ], baselineController.create);

  app.get(`${path}/baseline`, baselineController.findAll);

  app.get(`${path}/baseline/:baselineId`, [
    param('baselineId').isMongoId(),
  ], baselineController.findOne);

  app.put(`${path}/baseline/:baselineId`, [
    param('baselineId').isMongoId(),
    check('screenshotId').isMongoId().exists(),
  ], baselineController.update);

  app.delete(`${path}/baseline/:baselineId`, [
    param('baselineId').isMongoId(),
  ], baselineController.delete);
};

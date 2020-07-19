const { check, param, header } = require('express-validator');

const multerConfig = require('../utils/multer-config-screenshots.js');
const screenshotController = require('../controllers/screenshot.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/screenshot`, [
    header('buildId')
      .exists()
      .isMongoId(),
    header('timestamp')
      .exists()
      .isISO8601(),
    header('view')
      .optional()
      .isString(),
  ],
  multerConfig.single('screenshot'),
  screenshotController.create,
  screenshotController.createFail);

  app.get(`${path}/screenshot`, [
    param('buildId')
      .exists()
      .isMongoId(),
  ], screenshotController.findAll);

  app.get(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.findOne);

  app.get(`${path}/screenshot/:screenshotId/image`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.findOneImage);

  app.get(`${path}/screenshot/:screenshotId/compare/:screenshotCompareId`, [
    param('screenshotId').exists().isMongoId(),
    param('screenshotCompareId').exists().isMongoId(),
  ], screenshotController.compareImages);

  app.get(`${path}/screenshot/:screenshotId/compare/:screenshotCompareId/image`, [
    param('screenshotId').exists().isMongoId(),
    param('screenshotCompareId').exists().isMongoId(),
  ], screenshotController.compareImagesAndReturnImage);

  app.put(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
    check('platform').exists(),
    check('platform.platformName').exists().isString(),
    check('platform.platformVersion').optional().isString(),
    check('platform.browserName').optional().isString(),
    check('platform.browserVersion').optional().isString(),
    check('platform.deviceName').optional().isString(),
    check('platform.userAgent').optional().isString(),
    check('platform.screenHeight').optional().isNumeric(),
    check('platform.screenWidth').optional().isNumeric(),
    check('platform.pixelRatio').optional(),
  ], screenshotController.update);

  app.delete(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.delete);
};

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

  app.put(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
    check('name')
      .exists()
      .isString()
      .isLength({ max: 50 })
      .withMessage('Max length for team name is 50 characters'),
  ], screenshotController.update);

  app.delete(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.delete);
};

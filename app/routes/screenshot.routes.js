const { check, param, header } = require('express-validator');

const multerConfig = require('../utils/multer-config-screenshots.js');
const screenshotController = require('../controllers/screenshot.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/screenshot`, [
    header('buildId')
      .exists()
      .isMongoId(),
  ],
  multerConfig.single('screenshot'),
  screenshotController.create,
  screenshotController.createFail);

  app.post(`${path}/screenshot`, [
    check('name')
      .exists()
      .isString()
      .matches(/^[A-Za-z0-9\-\s]+$/)
      .withMessage('Name must only contain letters, numbers and hyphens.')
      .isLength({ max: 50 })
      .withMessage('Max length for environment name is 50 characters'),
  ], screenshotController.create);

  app.get(`${path}/screenshot`, screenshotController.findAll);

  app.get(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.findOne);

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

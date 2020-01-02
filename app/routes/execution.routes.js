const { check, param } = require('express-validator');

const executionController = require('../controllers/execution.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/execution`, [
    check('title').exists(),
    check('title')
      .isString()
      .isLength({ max: 150 })
      .withMessage('Max length for test title is 150 characters'),
    check('suite')
      .exists()
      .isString()
      .isLength({ max: 150 })
      .withMessage('Max length for suite name is 150 characters'),
    check('build')
      .exists()
      .isMongoId(),
    check('platforms').optional().isArray(),
    check('platforms.*.platformName').optional().isString(),
    check('platforms.*.platformVersion').optional().isString(),
    check('platforms.*.browserName').optional().isString(),
    check('platforms.*.browserVersion').optional().isString(),
    check('platforms.*.deviceName').optional().isString(),
    check('platforms.*.deviceBrand').optional().isString(),
    check('platforms.*.deviceModel').optional().isString(),
    check('platforms.*.userAgent').optional().isString(),
  ], executionController.create);

  app.get(`${path}/execution`, executionController.findAll);

  app.get(`${path}/execution/:executionId`, [
    param('executionId').isMongoId(),
  ], executionController.findOne);

  app.put(`${path}/execution/:executionId`, [
    param('executionId').isMongoId(),
  ], executionController.update);

  app.put(`${path}/execution/:executionId/platforms`, [
    param('executionId').isMongoId(),
    check('platforms')
      .exists()
      .custom((platformsArray) => Array.isArray(platformsArray) && platformsArray.length > 0)
      .withMessage('At least one platform is required'),
    check('platforms.*.platformName').exists(),
    check('platforms.*.platformName').isString(),
    check('platforms.*.platformVersion').optional().isString(),
    check('platforms.*.browserName').optional().isString(),
    check('platforms.*.browserVersion').optional().isString(),
    check('platforms.*.deviceName').optional().isString(),
    check('platforms.*.deviceBrand').optional().isString(),
    check('platforms.*.deviceModel').optional().isString(),
    check('platforms.*.userAgent').optional().isString(),
  ], executionController.setPlatform);

  app.delete(`${path}/execution/:executionId`, [
    param('executionId').isMongoId(),
  ], executionController.delete);
};

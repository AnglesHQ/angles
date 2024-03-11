const {
  check,
  query,
  param,
  oneOf,
  checkSchema,
} = require('express-validator');
const multerConfig = require('../utils/multer-config-screenshots.js');
const screenshotController = require('../controllers/screenshot.controller.js');

module.exports = (app, path) => {
  app.post(
    `${path}/screenshot`,
    multerConfig.single('screenshot'),
    [
      check('buildId')
        .exists()
        .isMongoId(),
      check('timestamp')
        .exists()
        .isISO8601(),
      check('view')
        .optional()
        .isString(),
      check('tags')
        .optional()
        .isString(),
      check('platformName')
        .optional()
        .isString(),
      check('platformVersion')
        .optional()
        .isString(),
      check('browserName')
        .optional()
        .isString(),
      check('browserVersion')
        .optional()
        .isString(),
      check('deviceName')
        .optional()
        .isString(),
    ],
    screenshotController.create,
    screenshotController.createFail,
  );

  app.get(`${path}/screenshot`, [
    oneOf([
      query('buildId')
        .optional()
        .isMongoId(),
      query('view')
        .optional()
        .isString(),
      query('platformId')
        .optional()
        .isString(),
      query('screenshotIds')
        .optional()
        .isString(),
    ]),
    query('limit')
      .optional()
      .isNumeric(),
    query('skip')
      .optional()
      .isNumeric(),
  ], screenshotController.findAll);

  app.get(`${path}/screenshot/views`, [
    query('view')
      .exists()
      .isString()
      .isLength({ min: 3, max: 100 })
      .withMessage('Please supply a minimum of 3 character to lookup view names.'),
    query('limit')
      .optional()
      .isNumeric(),
  ], screenshotController.findViewNames);

  app.get(`${path}/screenshot/tags`, [
    query('tag')
      .exists()
      .isString()
      .isLength({ min: 3, max: 100 })
      .withMessage('Please supply a minimum of 3 character to lookup tags.'),
    query('limit')
      .optional()
      .isNumeric(),
  ], screenshotController.findTagNames);

  app.get(`${path}/screenshot/grouped/platform`, [
    query('view')
      .exists()
      .isString(),
    query('numberOfDays')
      .exists()
      .isNumeric(),
  ], screenshotController.findLatestForViewGroupedByPlatform);

  app.get(`${path}/screenshot/grouped/tag`, [
    query('tag')
      .exists()
      .isString(),
    query('numberOfDays')
      .exists()
      .isNumeric(),
  ], screenshotController.findLatestForTagGroupedByView);

  app.get(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.findOne);

  app.get(`${path}/screenshot/:screenshotId/image`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.findOneImage);

  app.get(`${path}/screenshot/:screenshotId/dynamic-baseline`, [
    param('screenshotId').isMongoId(),
    query('numberOfImagesToCompare').optional().isNumeric(),
  ], screenshotController.generateDynamicBaselineImage);

  app.get(`${path}/screenshot/:screenshotId/compare/:screenshotCompareId`, [
    param('screenshotId').exists().isMongoId(),
    param('screenshotCompareId').exists().isMongoId(),
    query('useCache').optional().isBoolean(),
  ], screenshotController.compareImages);

  app.get(`${path}/screenshot/:screenshotId/compare/:screenshotCompareId/image`, [
    param('screenshotId').exists().isMongoId(),
    param('screenshotCompareId').exists().isMongoId(),
  ], screenshotController.compareImagesAndReturnImage);

  app.get(`${path}/screenshot/:screenshotId/baseline/compare`, [
    param('screenshotId').exists().isMongoId(),
  ], screenshotController.compareImageAgainstBaseline);

  app.get(`${path}/screenshot/:screenshotId/baseline/compare/image`, [
    param('screenshotId').exists().isMongoId(),
  ], screenshotController.compareImageAgainstBaselineAndReturnImage);

  app.put(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
    oneOf([
      checkSchema({
        platform: { optional: false },
        'platform.platformName': { optional: false, isString: true },
        'platform.platformVersion': { optional: true, isString: true },
        'platform.browserName': { optional: true, isString: true },
        'platform.browserVersion': { optional: true, isString: true },
        'platform.deviceName': { optional: true, isString: true },
      }),
      check('tags').exists().isArray(),
    ]),
  ], screenshotController.update);

  app.delete(`${path}/screenshot/:screenshotId`, [
    param('screenshotId').isMongoId(),
  ], screenshotController.delete);
};

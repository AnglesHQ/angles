const { validationResult } = require('express-validator');
const debug = require('debug');
const Baseline = require('../models/baseline.js');
const Screenshot = require('../models/screenshot.js');
const validationUtils = require('../utils/validation-utils.js');
const baselineUtils = require('../utils/baseline-utils.js');
const {
  NotFoundError,
  InvalidRequestError,
  ConflictError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('baseline:controller');

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }

  const { screenshotId, view: requestView, ignoreBoxes } = req.body;
  // determine if type is defined, otherwise set it to IMAGE (and handle default).
  const promises = [
    Screenshot.findById(screenshotId).exec(),
    Baseline.find({ view: requestView }).exec(),
  ];
  Promise.all(promises)
    .then((results) => {
      const screenshot = results[0];
      const baselinesFound = results[1];
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      const { view: screenshotView, platform } = screenshot;
      if (screenshotView !== requestView) {
        throw new InvalidRequestError(`The screenshot with id ${screenshotId} is not for the same view. Expected [${screenshotView}], Actual [${requestView}]`);
      }
      if (platform === undefined) {
        throw new InvalidRequestError(`The screenshot with id ${screenshotId} does not have platform details set. Platform details are required when setting a baseline image.`);
      }
      if (!validationUtils.screenshotHasValidPlatformDetails(screenshot)) {
        throw new InvalidRequestError(`The screenshot with id ${screenshotId} does not have valid platform details set. Please ensure that platform is set for the screenshot (with device name or browserName set)`);
      }
      const matchingBaselines = baselineUtils
        .checkIfBaselineAlreadyExists(requestView, baselinesFound, screenshot);

      const {
        platform: { deviceName, platformName, browserName },
        height,
        width,
      } = screenshot;
      if (matchingBaselines.length > 0) {
        if (deviceName) {
          throw new ConflictError(`Baseline for view [${requestView}], platform [${platformName}] and device [${deviceName}] already exists`);
        } else {
          throw new ConflictError(`Baseline for view [${requestView}], platform [${platformName}] and browser [${browserName}] with resolution [${width} x ${height}] already exists`);
        }
      }
      const baseline = baselineUtils.createBaseline(requestView, screenshot, ignoreBoxes);
      return baseline.save();
    })
    .then((savedBaseline) => {
      log(`Created baseline with id "${savedBaseline._id}" for view "${savedBaseline.view}" and platorm "${savedBaseline.platformName}"`);
      res.status(201).send(savedBaseline);
    }).catch((err) => {
      handleError(err, res);
    });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const {
    view,
    platformName,
    deviceName,
    browserName,
    screenHeight,
    screenWidth,
  } = req.query;
  const baseLineQuery = {
    view,
    'platform.platformName': platformName,
  };
  if (deviceName) baseLineQuery['platform.deviceName'] = deviceName;
  if (browserName) baseLineQuery['platform.browserName'] = browserName;
  if (screenHeight) baseLineQuery.screenHeight = screenHeight;
  if (screenWidth) baseLineQuery.screenWidth = screenWidth;
  Baseline.find(baseLineQuery)
    .populate('screenshot')
    .then((baselines) => {
      res.status(200).send(baselines);
    })
    .catch((err) => {
      handleError(err, res);
    });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { baselineId } = req.query;
  Baseline.findById(baselineId)
    .then((baseline) => {
      if (!baseline) {
        throw new NotFoundError(`Baseline not found with id ${baselineId}`);
      }
      res.status(200).send(baseline);
    }).catch((err) => {
      handleError(err, res);
    });
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { screenshotId, ignoreBoxes } = req.body;
  let screenshotPromise = new Promise((resolve) => { resolve(); });
  if (screenshotId) {
    screenshotPromise = Screenshot.findById(screenshotId).exec();
  }

  const { baselineId } = req.params;
  const promises = [
    screenshotPromise,
    Baseline.findById(baselineId).exec(),
  ];
  Promise.all(promises)
    .then((results) => {
      const screenshot = results[0];
      const baselineFound = results[1];
      if (screenshotId && !screenshot) {
        throw new NotFoundError(`Screenshot not found with id ${screenshotId}`);
      }
      if (!baselineFound) {
        throw new NotFoundError(`Baseline not found with id ${baselineId}`);
      }
      if (screenshotId && screenshot.view !== baselineFound.view) {
        throw new InvalidRequestError(`The screenshot with id ${screenshotId} has a different view to the baseline and therefore can not be used for the requested baseline. Expected [${screenshot.view}], Actual [${baselineFound.view}].`);
      }
      if (screenshotId && !validationUtils.doPlatformDetailsMatch(baselineFound, screenshot)) {
        throw new InvalidRequestError(`The screenshot with id ${screenshotId} has a different platform details to the baseline. Please ensure either the deviceName matches or the browserName and screenWidth and screenHeight`);
      }
      if (screenshotId) baselineFound.screenshot = screenshot;
      if (ignoreBoxes) {
        baselineFound.ignoreBoxes = ignoreBoxes;
      }
      return baselineFound.save();
    })
    .then((savedBaseline) => savedBaseline.populate('screenshot'))
    .then((savedBaselineWithScreenshot) => {
      res.status(200).send(savedBaselineWithScreenshot);
    })
    .catch((err) => {
      handleError(err, res);
    });
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { baselineId } = req.params;
  Baseline.findByIdAndRemove(baselineId)
    .then((baseline) => {
      if (!baseline) {
        throw new NotFoundError(`Baseline not found with id ${baselineId}`);
      }
      res.status(200).send({ message: 'Baseline deleted successfully!' });
    }).catch((err) => {
      handleError(err, res);
    });
};

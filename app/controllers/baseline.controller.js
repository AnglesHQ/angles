const { validationResult } = require('express-validator');
const debug = require('debug');
const Baseline = require('../models/baseline.js');
const Screenshot = require('../models/screenshot.js');
const validationUtils = require('../utils/validation-utils.js');

const log = debug('baseline:controller');

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const promises = [
    Screenshot.findById(req.body.screenshotId).exec(),
    Baseline.find({ view: req.body.view }).exec(),
  ];
  return Promise.all(promises).then((results) => {
    const screenshot = results[0];
    const baselinesFound = results[1];
    if (!screenshot) {
      return res.status(404).send({
        message: `No screenshot found with id ${req.body.screenshotId}`,
      });
    }
    if (screenshot.view !== req.body.view) {
      return res.status(400).send({
        message: `The screenshot with id ${req.body.screenshotId} is not for the same view. Expected [${screenshot.view}], Actual [${req.body.view}]`,
      });
    }
    if (screenshot.platform === undefined) {
      return res.status(400).send({
        message: `The screenshot with id ${req.body.screenshotId} does not have platform details set. Platform details are required when setting a baseline image.`,
      });
    }
    if (!validationUtils.screenshotHasValidPlatformDetails(screenshot)) {
      return res.status(400).send({
        message: `The screenshot with id ${req.body.screenshotId} does not have valid platform details set. Please ensure that platform is set for the screenshot (with device name or browserName set)`,
      });
    }

    if (screenshot.platform.deviceName) {
      const matchingBaselines = baselinesFound.filter((baseline) => baseline
        .platform.platformName === screenshot.platform.platformName
        && baseline.platform.deviceName === screenshot.platform.deviceName);
      if (matchingBaselines.length > 0) {
        return res.status(409).send({
          message: `Baseline for view [${screenshot.view}], platform [${screenshot.platform.platformName}] and device [${screenshot.platform.deviceName}] already exists`,
        });
      }
    }

    if (!screenshot.platform.deviceName) {
      const matchingBaselines = baselinesFound.filter((baseline) => baseline
        .platform.platformName === screenshot.platform.platformName
        && baseline.platform.browserName === screenshot.platform.browserName
        && baseline.screenHeight === screenshot.height
        && baseline.screenWidth === screenshot.width);
      if (matchingBaselines.length > 0) {
        return res.status(409).send({
          message: `Baseline for view [${screenshot.view}], platform [${screenshot.platform.platformName}] and browser [${screenshot.platform.browserName}] with resolution [${screenshot.width} x ${screenshot.height}] already exists`,
        });
      }
    }

    // create the baseline.
    const baseline = new Baseline({
      screenshot,
      view: req.body.view,
      platform: {
        platformName: screenshot.platform.platformName,
        deviceName: screenshot.platform.deviceName,
        browserName: screenshot.platform.browserName,
      },
      screenHeight: screenshot.height,
      screenWidth: screenshot.width,
    });
    if (req.body.ignoreBoxes) {
      baseline.ignoreBoxes = req.body.ignoreBoxes;
    }
    return baseline.save();
  }).then((savedBaseline) => {
    log(`Created baseline with id "${savedBaseline._id}" for view "${savedBaseline.view}" and platorm "${savedBaseline.platformName}"`);
    res.status(201).send(savedBaseline);
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while creating the baseline.',
    });
  });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const baseLineQuery = {
    view: req.query.view,
    'platform.platformName': req.query.platformName,
  };
  if (req.query.deviceName) baseLineQuery['platform.deviceName'] = req.query.deviceName;
  if (req.query.browserName) baseLineQuery['platform.browserName'] = req.query.browserName;
  if (req.query.screenHeight) baseLineQuery.screenHeight = req.query.screenHeight;
  if (req.query.screenWidth) baseLineQuery.screenWidth = req.query.screenWidth;
  return Baseline.find(baseLineQuery)
    .populate('screenshot')
    .then((baselines) => res.send(baselines))
    .catch((err) => res.status(500).send({
      message: err.message || 'Some error occurred while retrieving baselines.',
    }));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Baseline.findById(req.params.baselineId)
    .then((baseline) => {
      if (!baseline) {
        return res.status(404).send({
          message: `Baseline not found with id ${req.params.baselineId}`,
        });
      }
      return res.status(200).send(baseline);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving baseline with id ${req.params.baselineId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { screenshotId } = req.body;
  let screenshotPromise = new Promise((resolve) => { resolve(); });
  if (screenshotId) {
    screenshotPromise = Screenshot.findById(req.body.screenshotId).exec();
  }

  const promises = [
    screenshotPromise,
    Baseline.findById(req.params.baselineId).exec(),
  ];
  return Promise.all(promises).then((results) => {
    const screenshot = results[0];
    const baselineFound = results[1];
    if (screenshotId && !screenshot) {
      return res.status(404).send({
        message: `Screenshot not found with id ${req.body.screenshotId}`,
      });
    }
    if (!baselineFound) {
      return res.status(404).send({
        message: `Baseline not found with id ${req.params.baselineId}`,
      });
    }
    if (screenshotId && screenshot.view !== baselineFound.view) {
      return res.status(400).send({
        message: `The screenshot with id ${req.body.screenshotId} has a different view to the baseline and therefore can not be used for the requested baseline. Expected [${screenshot.view}], Actual [${baselineFound.view}].`,
      });
    }
    if (screenshotId && !validationUtils.doPlatformDetailsMatch(baselineFound, screenshot)) {
      return res.status(400).send({
        message: `The screenshot with id ${req.body.screenshotId} has a different platform details to the baseline. Please ensure either the deviceName matches or the browserName and screenWidth and screenHeight`,
      });
    }
    if (screenshotId) baselineFound.screenshot = screenshot;
    if (req.body.ignoreBoxes) {
      baselineFound.ignoreBoxes = req.body.ignoreBoxes;
    }
    return baselineFound.save();
  })
    .then((savedBaseline) => savedBaseline.populate('screenshot').execPopulate())
    .then((savedBaselinedWithScreenshot) => res.status(200).send(savedBaselinedWithScreenshot))
    .catch((err) => res.status(500).send({
      message: `Error updating build with id ${req.params.baselineId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Baseline.findByIdAndRemove(req.params.baselineId)
    .then((baseline) => {
      if (!baseline) {
        return res.status(404).send({
          message: `Baseline not found with id ${req.params.baselineId}`,
        });
      }
      return res.status(200).send({ message: 'Baseline deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete baseline with id ${req.params.baselineId} due to [${err}]`,
    }));
};

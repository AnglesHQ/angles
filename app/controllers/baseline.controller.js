const { validationResult } = require('express-validator');
const debug = require('debug');
const Baseline = require('../models/baseline.js');
const Build = require('../models/build.js');
const Screenshot = require('../models/screenshot.js');
const validationUtils = require('../utils/validation-utils.js');
const baselineUtils = require('../utils/baseline-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  InvalidRequestError,
  ConflictError,
  ForbiddenError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('baseline:controller');

// The team a screenshot belongs to, through its build. A screenshot whose build is gone
// cannot be attributed to a team, so it cannot back a baseline.
const teamOfScreenshot = async (screenshot) => {
  const build = await Build.findById(screenshot.build).select('team').lean().exec();
  if (!build) {
    throw new NotFoundError(`No build found for screenshot with id ${screenshot._id}`);
  }
  return build.team;
};

// A baseline is readable and editable by its team. One written before baselines recorded
// a team (and not yet backfilled) cannot be attributed, so only an admin may touch it.
const hasBaselineAccess = (user, baseline) => (baseline.team
  ? authMiddleware.hasTeamAccess(user, baseline.team)
  : Boolean(user && user.role === 'admin'));

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { screenshotId, view: requestView, ignoreBoxes } = req.body;
  let team;
  return Screenshot.findById(screenshotId).lean().exec()
    .then(async (screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      team = await teamOfScreenshot(screenshot);
      if (!authMiddleware.hasTeamAccess(req.user, team)) {
        throw new ForbiddenError('You do not have access to this screenshot');
      }
      // Only this team's baselines count: another team may use the same view name.
      const baselinesFound = await Baseline.find({ team, view: requestView }).lean().exec();
      return { screenshot, baselinesFound };
    })
    .then(({ screenshot, baselinesFound }) => {
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
      const baseline = baselineUtils.createBaseline(requestView, screenshot, ignoreBoxes, team);
      return baseline.save();
    })
    .then((savedBaseline) => {
      log(`Created baseline with id "${savedBaseline._id}" for view "${savedBaseline.view}" and platorm "${savedBaseline.platformName}"`);
      // populate the screenshot so the response matches the shape returned by find/update
      return savedBaseline.populate('screenshot');
    })
    .then((savedBaselineWithScreenshot) => res.status(201).send(savedBaselineWithScreenshot))
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    view,
    platformName,
    deviceName,
    browserName,
    screenHeight,
    screenWidth,
    teamId,
  } = req.query;
  const baseLineQuery = {
    view,
    'platform.platformName': platformName,
  };
  // Baselines are per team. A named team must be one the caller can read; otherwise the
  // result is limited to the caller's own teams (admins, who can read every team, are not
  // limited, so an admin should name the team when view names collide across teams).
  if (teamId) {
    if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
      return handleError(new ForbiddenError('You do not have access to this team'), res);
    }
    baseLineQuery.team = teamId;
  } else if (!req.user || req.user.role !== 'admin') {
    baseLineQuery.team = { $in: (req.user && req.user.teams) || [] };
  }
  if (deviceName) baseLineQuery['platform.deviceName'] = deviceName;
  if (browserName) baseLineQuery['platform.browserName'] = browserName;
  if (screenHeight) baseLineQuery.screenHeight = screenHeight;
  if (screenWidth) baseLineQuery.screenWidth = screenWidth;
  return Baseline.find(baseLineQuery)
    .populate('screenshot')
    .lean()
    .then((baselines) => res.status(200).send(baselines))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { baselineId } = req.params;
  return Baseline.findById(baselineId).lean()
    .then((baseline) => {
      if (!baseline) {
        throw new NotFoundError(`Baseline not found with id ${baselineId}`);
      }
      if (!hasBaselineAccess(req.user, baseline)) {
        throw new ForbiddenError('You do not have access to this baseline');
      }
      return res.status(200).send(baseline);
    }).catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { screenshotId, ignoreBoxes } = req.body;
  let screenshotPromise = new Promise((resolve) => { resolve(); });
  if (screenshotId) {
    screenshotPromise = Screenshot.findById(screenshotId).lean().exec();
  }

  const { baselineId } = req.params;
  const promises = [
    screenshotPromise,
    Baseline.findById(baselineId).exec(),
  ];
  return Promise.all(promises)
    .then(async (results) => {
      const screenshot = results[0];
      const baselineFound = results[1];
      if (screenshotId && !screenshot) {
        throw new NotFoundError(`Screenshot not found with id ${screenshotId}`);
      }
      if (!baselineFound) {
        throw new NotFoundError(`Baseline not found with id ${baselineId}`);
      }
      if (!hasBaselineAccess(req.user, baselineFound)) {
        throw new ForbiddenError('You do not have access to this baseline');
      }
      // The new image has to come from the baseline's own team, or a baseline could be
      // pointed at (and so expose) another team's screenshot.
      if (screenshotId) {
        const screenshotTeam = await teamOfScreenshot(screenshot);
        const baselineTeam = baselineFound.team || screenshotTeam;
        if (screenshotTeam.toString() !== baselineTeam.toString()
          || !authMiddleware.hasTeamAccess(req.user, screenshotTeam)) {
          throw new ForbiddenError('The screenshot must belong to the same team as the baseline');
        }
        if (!baselineFound.team) baselineFound.team = screenshotTeam;
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
    .then((savedBaselineWithScreenshot) => res.status(200).send(savedBaselineWithScreenshot))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { baselineId } = req.params;
  return Baseline.findById(baselineId)
    .populate({
      path: 'screenshot',
      populate: { path: 'build' },
    })
    .then((baselineFound) => {
      if (!baselineFound) {
        throw new NotFoundError(`Baseline not found with id ${baselineId}`);
      }
      const team = baselineFound.team
        || (baselineFound.screenshot && baselineFound.screenshot.build
          && baselineFound.screenshot.build.team);
      if (!team || !authMiddleware.hasTeamLeadAccess(req.user, team)) {
        throw new ForbiddenError('You do not have permission to delete this baseline');
      }
      return Baseline.findByIdAndRemove(baselineId);
    })
    .then(() => res.status(200).send({ message: 'Baseline deleted successfully!' }))
    .catch((err) => handleError(err, res));
};

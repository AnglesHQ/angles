const debug = require('debug');
const Baseline = require('../models/baseline.js');
const Build = require('../models/build.js');
const Screenshot = require('../models/screenshot.js');

const log = debug('baseline:utils');

const baselineUtils = {};

baselineUtils.createBaseline = (view, screenshot, ignoreBoxes, team) => {
  // TODO: Handle type now for Image or Dynamic
  const {
    platform: { deviceName, platformName, browserName },
    height,
    width,
  } = screenshot;
  const baseline = new Baseline({
    team,
    screenshot,
    view,
    platform: {
      platformName,
      deviceName,
      browserName,
    },
    screenHeight: height,
    screenWidth: width,
  });
  if (ignoreBoxes) {
    baseline.ignoreBoxes = ignoreBoxes;
  }
  return baseline;
};

baselineUtils.checkIfBaselineAlreadyExists = (requestView, baselinesFound, screenshot) => {
  const {
    platform: { deviceName, platformName, browserName },
    height,
    width,
  } = screenshot;
  let matchingBaselines;
  if (deviceName) {
    matchingBaselines = baselinesFound.filter((baseline) => baseline
      .platform.platformName === platformName
      && baseline.platform.deviceName === deviceName);
  } else {
    matchingBaselines = baselinesFound.filter((baseline) => baseline
      .platform.platformName === platformName
      && baseline.platform.browserName === browserName
      && baseline.screenHeight === height
      && baseline.screenWidth === width);
  }
  return matchingBaselines;
};

/*
Builds the query that finds the baseline a screenshot should be compared against: same
team, same view and same platform (device, or browser plus resolution).
 */
baselineUtils.baselineQueryForScreenshot = (screenshot, team) => {
  const {
    view, platform, height, width,
  } = screenshot;
  const query = {
    team,
    view,
    'platform.platformName': platform.platformName,
  };
  if (platform.deviceName) query['platform.deviceName'] = platform.deviceName;
  if (platform.browserName) {
    query['platform.browserName'] = platform.browserName;
    query.screenHeight = height;
    query.screenWidth = width;
  }
  return query;
};

/*
Sets `team` on baselines written before it was recorded, from the build of the
baseline's screenshot. Baselines are now looked up per team, so one without a team is
never matched for a comparison; this restores them.

Safe to run repeatedly: only baselines with no team are touched, and a baseline whose
screenshot or build is gone is left as it is (it cannot be attributed to a team).
 */
baselineUtils.backfillTeams = async () => {
  const baselines = await Baseline.find({ team: { $exists: false } })
    .select('_id screenshot').lean().exec();
  let updated = 0;
  // Baselines number in the tens or hundreds, so one at a time keeps this simple.
  // eslint-disable-next-line no-restricted-syntax
  for (const baseline of baselines) {
    // eslint-disable-next-line no-await-in-loop
    const screenshot = await Screenshot.findById(baseline.screenshot).select('build').lean().exec();
    // eslint-disable-next-line no-await-in-loop
    const build = screenshot ? await Build.findById(screenshot.build).select('team').lean().exec() : null;
    if (build && build.team) {
      // eslint-disable-next-line no-await-in-loop
      await Baseline.updateOne({ _id: baseline._id }, { $set: { team: build.team } }).exec();
      updated += 1;
    } else {
      log(`Baseline ${baseline._id} has no screenshot or build left; leaving it without a team`);
    }
  }
  return { checked: baselines.length, updated };
};

module.exports = baselineUtils;

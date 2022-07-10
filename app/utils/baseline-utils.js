const Baseline = require('../models/baseline.js');

const baselineUtils = {};

baselineUtils.createBaseline = (view, screenshot, ignoreBoxes) => {
  // TODO: Handle type now for Image or Dynamic
  const {
    platform: { deviceName, platformName, browserName },
    height,
    width,
  } = screenshot;
  const baseline = new Baseline({
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

module.exports = baselineUtils;

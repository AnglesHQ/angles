const fs = require('fs');
const path = require('path');
const debug = require('debug');
// rimraf v4+ exports named functions rather than a callable module, so destructure it.
// Requiring the module itself gives an object and every call throws "rimraf is not a
// function", which silently broke screenshot directory clean-up.
const { rimraf } = require('rimraf');
const jimp = require('jimp');
const Screenshot = require('../models/screenshot.js');
const engine = require('../image-engine/index.js');
const { optionsHash } = require('../image-engine/cache.js');

const imageUtils = {};

const log = debug('screenshot:utility');

// Baseline compares pass lean objects (no mongoose `id` getter), so fall back to _id.
// Without this every lean compare cached to the same "undefined_undefined" filename and
// could serve one comparison's diff image for a completely different pair of screenshots.
const screenshotId = (screenshot) => screenshot.id || screenshot._id;

/**
 * Compare two screenshot objects and return the path to the diff image file.
 * The cached filename embeds the comparison options, so a request with different
 * ignore boxes or threshold never reuses a diff generated with other settings.
 */
imageUtils.compareImages = (screenshot, screenshotToCompare, ignoredBoxes, useCache, threshold) => {
  const cacheKey = optionsHash({ ignoredBoxes, threshold });
  const fileName = `compares/${screenshotId(screenshotToCompare)}_${screenshotId(screenshot)}-compare-${cacheKey}.png`;
  return imageUtils.compareImagesAndPassResultName(
    screenshot,
    screenshotToCompare,
    useCache,
    fileName,
    ignoredBoxes,
    threshold,
  );
};

/**
 * Compare two screenshot objects, write the diff PNG to fileName, and resolve with the
 * absolute file path. The comparison itself runs on the image-engine worker pool.
 */
imageUtils.compareImagesAndPassResultName = (
  screenshot,
  screenshotToCompare,
  useCache,
  fileName,
  ignoredBoxes,
  threshold,
) => new Promise((resolve, reject) => {
  const absolutePath = path.resolve(fileName);
  fs.access(absolutePath, fs.constants.F_OK, (err) => {
    // File doesn't exist, or cache disabled - generate the diff
    if (err || useCache === 'false' || useCache === false) {
      engine.compareAndWriteDiff(
        screenshotToCompare.path,
        screenshot.path,
        absolutePath,
        { ignoredBoxes, threshold },
      )
        .then(() => resolve(absolutePath))
        .catch(reject);
    } else {
      // File exists and cache is enabled
      resolve(absolutePath);
    }
  });
});

/**
 * Compare two image file paths and return a JSON-compatible result object.
 * Used by the controller endpoints that return comparison data (not a diff image).
 * @param {string} path1
 * @param {string} path2
 * @param {Array}  ignoredBoxes
 * @param {number} [threshold] - per-pixel colour-distance threshold (0-1)
 * @returns {Promise<Object>} { misMatchPercentage, rawMisMatchPercentage,
 *   isSameDimensions, dimensionDifference, analysisTime }
 */
imageUtils.compareAndGetResult = async (path1, path2, ignoredBoxes, threshold) => {
  const start = Date.now();
  const {
    misMatchPercentage,
    rawMisMatchPercentage,
    isSameDimensions,
    dimensionDifference,
  } = await engine.compareStats(path1, path2, { ignoredBoxes, threshold });
  return {
    misMatchPercentage,
    rawMisMatchPercentage,
    isSameDimensions,
    dimensionDifference,
    analysisTime: Date.now() - start,
  };
};

const SCREENSHOT_ROOT = path.resolve(__dirname, '../../screenshots');

imageUtils.removeScreenshotDirectories = (buildsToDelete) => {
  const buildIds = buildsToDelete.map((build) => build._id.toString());
  log(`Deleting screenshots for builds with ids ${buildIds}`);
  const promises = buildIds.map((buildId) => {
    const directoryToRemove = path.join(SCREENSHOT_ROOT, buildId);
    // This is a recursive delete, so never let a malformed id escape the screenshots root.
    if (!directoryToRemove.startsWith(SCREENSHOT_ROOT + path.sep)) {
      log(`Refusing to remove directory outside the screenshot root: ${directoryToRemove}`);
      return Promise.resolve();
    }
    return rimraf(directoryToRemove).then(() => {
      log(`Removed directory ${directoryToRemove}`);
    });
  });
  return Promise.all(promises).then(() => ({ deleted: buildIds.length }));
};

imageUtils.generateDynamicBaseline = async (screenshot, screenshots) => {
  // ensure path exists due to an old bug
  const buildPath = `screenshots/${screenshot.build}`;
  if (!fs.existsSync(buildPath)) {
    fs.mkdirSync(buildPath);
  }
  // file name we'll be overriding it a few times.
  const fileName = `${buildPath}/${screenshot.id}-${Date.now()}-dynamic-baseline.png`;
  const currentScreenshotObject = screenshot.toObject ? screenshot.toObject() : { ...screenshot };
  delete currentScreenshotObject._id;
  const currentScreenshot = new Screenshot(currentScreenshotObject);
  let dynamicBaselinePath;
  // eslint-disable-next-line no-restricted-syntax
  for await (const currentScreenshotToCompare of screenshots) {
    dynamicBaselinePath = await imageUtils.compareImagesAndPassResultName(
      currentScreenshot,
      currentScreenshotToCompare,
      false,
      fileName,
      undefined,
    );
    // update details
    currentScreenshot.path = fileName;
    currentScreenshot.timestamp = new Date();
  }
  // once dynamic image is ready generate thumbnail
  const image = await jimp.read(dynamicBaselinePath);
  const thumbnail = await image
    .scaleToFit(300, 300)
    .quality(72)
    .getBase64Async(image.getMIME());
  currentScreenshot.thumbnail = thumbnail;
  currentScreenshot.type = 'DYNAMIC';
  return currentScreenshot;
};

module.exports = imageUtils;

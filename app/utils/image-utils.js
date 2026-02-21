const fs = require('fs');
const path = require('path');
const debug = require('debug');
const fsPromises = require('fs').promises;
// eslint-disable-next-line import/extensions
const compareImages = require('resemblejs/compareImages');
const rimraf = require('rimraf');
const jimp = require('jimp');
const Screenshot = require('../models/screenshot.js');

const imageUtils = {};

const log = debug('screenshot:utility');

const defaultOptions = {
  output: {
    errorColor: { red: 255, green: 0, blue: 255 },
    errorType: 'flat',
    transparency: 0.3,
    largeImageThreshold: 1200,
    useCrossOrigin: false,
    outputDiff: true,
    ignore: 'less',
  },
  scaleToSameSize: true,
  ignore: 'less',
};

imageUtils.compareImages = (screenshot, screenshotToCompare, ignoredBoxes, useCache) => {
  const fileName = `compares/${screenshotToCompare.id}_${screenshot.id}-compare.png`;
  const options = {
    ...defaultOptions,
    output: {
      ...defaultOptions.output,
      ignoredBoxes,
      ignoreAreasColoredWith: { r: 255, g: 0, b: 255 },
    },
  };
  return imageUtils.compareImagesAndPassResultName(
    screenshot,
    screenshotToCompare,
    useCache,
    fileName,
    options,
  );
};

imageUtils.compareImagesAndPassResultName = (
  screenshot,
  screenshotToCompare,
  useCache,
  fileName,
  options,
) => new Promise((resolve) => {
  fs.access(fileName, fs.constants.F_OK, (err) => {
    // file doesn't exist then create it by doing the compare.
    if (err || useCache === 'false' || useCache === false) {
      const loadImagesPromises = [
        fsPromises.readFile(screenshotToCompare.path),
        fsPromises.readFile(screenshot.path),
      ];
      return Promise.all(loadImagesPromises)
        .then((imageLoadResults) => {
          compareImages(
            imageLoadResults[0],
            imageLoadResults[1],
            options,
          )
            .then((data) => fsPromises.writeFile(path.resolve(fileName), data.getBuffer()))
            .then(() => resolve(path.resolve(fileName)));
        });
    }
    // if file exists and useCache is true
    return resolve(path.resolve(fileName));
  });
});

imageUtils.removeScreenshotDirectories = (buildsToDelete) => {
  const buildIds = buildsToDelete.map((build) => build._id.toString());
  log(`Deleting screenshots for builds with ids ${buildIds}`);
  return new Promise((resolve) => {
    // do a thing, possibly async, then…
    buildIds.forEach((buildId) => {
      const directoryToRemove = path.join(__dirname, `../../screenshots/${buildId}`);
      rimraf(directoryToRemove, () => {
        log(`Removed directory ${directoryToRemove}`);
      });
    });
    resolve({ deleted: buildIds.length });
  });
};

imageUtils.generateDynamicBaseline = async (screenshot, screenshots) => {
  // ensure path exists due to an old bug
  const buildPath = `screenshots/${screenshot.build}`;
  if (!fs.existsSync(buildPath)) {
    fs.mkdirSync(buildPath);
  }
  // file name we'll be overriding it a few times.
  const fileName = `${buildPath}/${screenshot.id}-${Date.now()}-dynamic-baseline.png`;
  const currentScreenshotObject = screenshot.toObject();
  delete currentScreenshotObject._id;
  const currentScreenshot = new Screenshot(currentScreenshotObject);
  let dynamicBaselinePath;
  const options = {
    ...defaultOptions,
    output: {
      ...defaultOptions.output,
      ignore: 'alpha',
    },
  };
  delete options.output.transparency;
  // eslint-disable-next-line no-restricted-syntax
  for await (const currentScreenshotToCompare of screenshots) {
    dynamicBaselinePath = await imageUtils.compareImagesAndPassResultName(
      currentScreenshot,
      currentScreenshotToCompare,
      false,
      fileName,
      options,
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

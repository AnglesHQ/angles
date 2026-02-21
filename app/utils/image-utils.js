const fs = require('fs');
const path = require('path');
const debug = require('debug');
const fsPromises = require('fs').promises;
const pixelmatch = require('pixelmatch');
const rimraf = require('rimraf');
const jimp = require('jimp');
const Screenshot = require('../models/screenshot.js');

const imageUtils = {};

const log = debug('screenshot:utility');

/**
 * Internal helper: compare two image files using pixelmatch.
 * Handles dimension mismatches and ignoredBoxes masking.
 * @param {string} path1 - path to the first image (screenshotToCompare)
 * @param {string} path2 - path to the second image (screenshot)
 * @param {Array}  ignoredBoxes - array of { left, right, top, bottom } pixel coords to ignore
 * @returns {Promise<Object>} comparison result
 */
const performPixelmatch = async (path1, path2, ignoredBoxes) => {
  const [img1, img2] = await Promise.all([jimp.read(path1), jimp.read(path2)]);

  const w1 = img1.bitmap.width;
  const h1 = img1.bitmap.height;
  const isSameDimensions = w1 === img2.bitmap.width && h1 === img2.bitmap.height;
  const dimensionDifference = {
    width: w1 - img2.bitmap.width,
    height: h1 - img2.bitmap.height,
  };

  // Resize img2 to img1 dimensions if they differ
  if (!isSameDimensions) {
    img2.resize(w1, h1);
  }

  const { width: w, height: h } = img1.bitmap;
  const data1 = img1.bitmap.data;
  const data2 = img2.bitmap.data;

  // Make ignoredBoxes regions identical in both images so pixelmatch skips them
  if (ignoredBoxes && ignoredBoxes.length > 0) {
    ignoredBoxes.forEach(({ left, right, top, bottom }) => {
      for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
        for (let x = Math.floor(left); x < Math.ceil(right); x++) {
          if (x >= 0 && x < w && y >= 0 && y < h) {
            const idx = (y * w + x) * 4;
            data2[idx] = data1[idx];
            data2[idx + 1] = data1[idx + 1];
            data2[idx + 2] = data1[idx + 2];
            data2[idx + 3] = data1[idx + 3];
          }
        }
      }
    });
  }

  const diff = Buffer.alloc(w * h * 4);
  const numDiffPixels = pixelmatch(data1, data2, diff, w, h, { threshold: 0.1 });
  const rawMisMatchPercentage = (numDiffPixels / (w * h)) * 100;

  return {
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage: rawMisMatchPercentage.toFixed(2),
    diff,
    width: w,
    height: h,
  };
};

/**
 * Compare two screenshot objects and return the path to the diff image file.
 * Wraps compareImagesAndPassResultName with a standard filename.
 */
imageUtils.compareImages = (screenshot, screenshotToCompare, ignoredBoxes, useCache) => {
  const fileName = `compares/${screenshotToCompare.id}_${screenshot.id}-compare.png`;
  return imageUtils.compareImagesAndPassResultName(
    screenshot,
    screenshotToCompare,
    useCache,
    fileName,
    ignoredBoxes,
  );
};

/**
 * Compare two screenshot objects, write the diff PNG to fileName, and resolve with the file path.
 */
imageUtils.compareImagesAndPassResultName = (
  screenshot,
  screenshotToCompare,
  useCache,
  fileName,
  ignoredBoxes,
) => new Promise((resolve, reject) => {
  fs.access(fileName, fs.constants.F_OK, async (err) => {
    // File doesn't exist, or cache disabled — generate the diff
    if (err || useCache === 'false' || useCache === false) {
      try {
        const result = await performPixelmatch(
          screenshotToCompare.path,
          screenshot.path,
          ignoredBoxes,
        );
        // Write diff pixels as a PNG via jimp
        const diffJimp = new jimp({ data: result.diff, width: result.width, height: result.height });
        const diffBuffer = await diffJimp.getBufferAsync(jimp.MIME_PNG);
        await fsPromises.writeFile(path.resolve(fileName), diffBuffer);
        resolve(path.resolve(fileName));
      } catch (e) {
        reject(e);
      }
    } else {
      // File exists and cache is enabled
      resolve(path.resolve(fileName));
    }
  });
});

/**
 * Compare two image file paths and return a JSON-compatible result object.
 * Used by the controller endpoints that return comparison data (not a diff image).
 * @param {string} path1
 * @param {string} path2
 * @param {Array}  ignoredBoxes
 * @returns {Promise<Object>} { misMatchPercentage, rawMisMatchPercentage, isSameDimensions, dimensionDifference }
 */
imageUtils.compareAndGetResult = async (path1, path2, ignoredBoxes) => {
  const {
    misMatchPercentage,
    rawMisMatchPercentage,
    isSameDimensions,
    dimensionDifference,
  } = await performPixelmatch(path1, path2, ignoredBoxes);
  return {
    misMatchPercentage,
    rawMisMatchPercentage,
    isSameDimensions,
    dimensionDifference,
  };
};

imageUtils.removeScreenshotDirectories = (buildsToDelete) => {
  const buildIds = buildsToDelete.map((build) => build._id.toString());
  log(`Deleting screenshots for builds with ids ${buildIds}`);
  return new Promise((resolve) => {
    buildIds.forEach((buildId) => {
      const directoryToRemove = path.join(__dirname, `../../screenshots/${buildId}`);
      rimraf(directoryToRemove).then(() => {
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

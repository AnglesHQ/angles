const path = require('path');
const fsPromises = require('fs').promises;
const jimp = require('jimp');
const pixelmatch = require('pixelmatch');

const pixel = {};

// Per-pixel colour-distance threshold for pixelmatch (0-1, lower is stricter). 0.5 is the
// value the API has always used, so it stays the default when no threshold is supplied.
const DEFAULT_THRESHOLD = 0.5;
const DIFF_COLOR = [255, 0, 255];
const DIFF_ALPHA = 0.3;

/**
 * Make the ignoredBoxes regions identical in both images so pixelmatch skips them.
 * Boxes are absolute pixel coords { left, right, top, bottom } within the compared area.
 */
const applyIgnoredBoxes = (img1, img2, ignoredBoxes) => {
  if (!ignoredBoxes || ignoredBoxes.length === 0) return;
  const { width, height } = img1.bitmap;
  const data1 = img1.bitmap.data;
  const data2 = img2.bitmap.data;
  ignoredBoxes.forEach(({
    left, right, top, bottom,
  }) => {
    for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
      for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
        if (x >= 0 && x < width && y >= 0 && y < height) {
          const idx = (y * width + x) * 4;
          data2[idx] = data1[idx];
          data2[idx + 1] = data1[idx + 1];
          data2[idx + 2] = data1[idx + 2];
          data2[idx + 3] = data1[idx + 3];
        }
      }
    }
  });
};

// Same luma coefficients pixelmatch uses when it fades unchanged pixels, so letterboxed
// areas (present in only one of the two images) read the same way in the diff image.
const fadedGray = (r, g, b) => {
  const luma = 0.29889531 * r + 0.58662247 * g + 0.11448223 * b;
  return Math.round(255 + (luma - 255) * DIFF_ALPHA);
};

/**
 * Paint the parts of `source` that fall outside the shared (compared) region into the
 * union-sized diff image as faded grayscale, so the viewer can see what only exists in
 * one of the two images without it being counted as a pixel difference.
 */
const paintOutsideSharedRegion = (diffImage, source, sharedWidth, sharedHeight) => {
  const { width, height, data } = source.bitmap;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < sharedWidth && y < sharedHeight) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const idx = (y * width + x) * 4;
      const gray = fadedGray(data[idx], data[idx + 1], data[idx + 2]);
      diffImage.setPixelColor(jimp.rgbaToInt(gray, gray, gray, 255), x, y);
    }
  }
};

/**
 * Compare two images with pixelmatch. Images of different sizes are letterboxed, never
 * stretched: the comparison (and the mismatch percentage) covers only the shared
 * top-left region, because resizing one image to the other's dimensions distorts it and
 * manufactures diff noise - exactly the mobile-vs-desktop case.
 * @param {string} path1
 * @param {string} path2
 * @param {Object} [options] - { ignoredBoxes, threshold }
 * @param {boolean} [buildDiffImage] - also build the union-sized diff image
 * @returns {Promise<Object>} stats, plus diffImage (jimp) when buildDiffImage is set
 */
const compare = async (path1, path2, options = {}, buildDiffImage = false) => {
  const threshold = options.threshold === undefined ? DEFAULT_THRESHOLD : options.threshold;
  const [img1, img2] = await Promise.all([jimp.read(path1), jimp.read(path2)]);
  const width1 = img1.bitmap.width;
  const height1 = img1.bitmap.height;
  const width2 = img2.bitmap.width;
  const height2 = img2.bitmap.height;
  const isSameDimensions = width1 === width2 && height1 === height2;
  const dimensionDifference = { width: width1 - width2, height: height1 - height2 };
  const sharedWidth = Math.min(width1, width2);
  const sharedHeight = Math.min(height1, height2);
  const unionWidth = Math.max(width1, width2);
  const unionHeight = Math.max(height1, height2);

  const shared1 = isSameDimensions ? img1 : img1.clone().crop(0, 0, sharedWidth, sharedHeight);
  const shared2 = isSameDimensions ? img2 : img2.clone().crop(0, 0, sharedWidth, sharedHeight);
  applyIgnoredBoxes(shared1, shared2, options.ignoredBoxes);

  const diffBuffer = Buffer.alloc(sharedWidth * sharedHeight * 4);
  const numDiffPixels = pixelmatch(
    shared1.bitmap.data,
    shared2.bitmap.data,
    diffBuffer,
    sharedWidth,
    sharedHeight,
    { threshold, diffColor: DIFF_COLOR, alpha: DIFF_ALPHA },
  );
  const rawMisMatchPercentage = (numDiffPixels / (sharedWidth * sharedHeight)) * 100;

  const result = {
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage: rawMisMatchPercentage.toFixed(2),
    width: unionWidth,
    height: unionHeight,
  };

  if (buildDiffImage) {
    // eslint-disable-next-line new-cap
    const sharedDiffImage = new jimp({
      data: diffBuffer, width: sharedWidth, height: sharedHeight,
    });
    if (isSameDimensions) {
      result.diffImage = sharedDiffImage;
    } else {
      // eslint-disable-next-line new-cap
      const unionDiffImage = new jimp(unionWidth, unionHeight, 0xffffffff);
      paintOutsideSharedRegion(unionDiffImage, img1, sharedWidth, sharedHeight);
      paintOutsideSharedRegion(unionDiffImage, img2, sharedWidth, sharedHeight);
      unionDiffImage.composite(sharedDiffImage, 0, 0);
      result.diffImage = unionDiffImage;
    }
  }
  return result;
};

/**
 * Compare two image files and return the comparison statistics.
 */
pixel.compareStats = async (path1, path2, options) => {
  const {
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage,
  } = await compare(path1, path2, options, false);
  return {
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage,
  };
};

/**
 * Compare two image files, write the diff PNG to outputFile, and return the statistics
 * plus the absolute path of the written file.
 */
pixel.compareAndWriteDiff = async (path1, path2, outputFile, options) => {
  const result = await compare(path1, path2, options, true);
  const buffer = await result.diffImage.getBufferAsync(jimp.MIME_PNG);
  const absolutePath = path.resolve(outputFile);
  await fsPromises.writeFile(absolutePath, buffer);
  const {
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage,
  } = result;
  return {
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage,
    diffPath: absolutePath,
  };
};

module.exports = pixel;

const jimp = require('jimp');

/**
 * Shared image loading/normalisation helpers used by the comparison strategies.
 *
 * All strategies letterbox rather than stretch: images of different sizes are compared
 * over the shared top-left region only, because resizing one image to the other's
 * dimensions distorts it and manufactures diff noise (the mobile-vs-desktop case).
 */
const images = {};

// Matches the alpha pixelmatch uses when it fades unchanged pixels, so every kind of
// diff image reads the same way in the UI.
const DIFF_ALPHA = 0.3;

/**
 * Load both images and derive the shared/union geometry.
 * @returns {Promise<Object>} { img1, img2, shared1, shared2, isSameDimensions,
 *   dimensionDifference, sharedWidth, sharedHeight, unionWidth, unionHeight }
 */
images.loadPair = async (path1, path2) => {
  const [img1, img2] = await Promise.all([jimp.read(path1), jimp.read(path2)]);
  const width1 = img1.bitmap.width;
  const height1 = img1.bitmap.height;
  const width2 = img2.bitmap.width;
  const height2 = img2.bitmap.height;
  const isSameDimensions = width1 === width2 && height1 === height2;
  const sharedWidth = Math.min(width1, width2);
  const sharedHeight = Math.min(height1, height2);
  return {
    img1,
    img2,
    shared1: isSameDimensions ? img1 : img1.clone().crop(0, 0, sharedWidth, sharedHeight),
    shared2: isSameDimensions ? img2 : img2.clone().crop(0, 0, sharedWidth, sharedHeight),
    isSameDimensions,
    dimensionDifference: { width: width1 - width2, height: height1 - height2 },
    sharedWidth,
    sharedHeight,
    unionWidth: Math.max(width1, width2),
    unionHeight: Math.max(height1, height2),
  };
};

/**
 * Make the ignoredBoxes regions identical in both images so a comparison skips them.
 * Boxes are absolute pixel coords { left, right, top, bottom } within the compared area.
 */
images.applyIgnoredBoxes = (img1, img2, ignoredBoxes) => {
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

// Same luma coefficients pixelmatch uses when it fades unchanged pixels.
images.fadedGray = (r, g, b) => {
  const luma = 0.29889531 * r + 0.58662247 * g + 0.11448223 * b;
  return Math.round(255 + (luma - 255) * DIFF_ALPHA);
};

/**
 * Paint the parts of `source` that fall outside the shared (compared) region into the
 * union-sized diff image as faded grayscale, so the viewer can see what only exists in
 * one of the two images without it being counted as a difference.
 */
images.paintOutsideSharedRegion = (diffImage, source, sharedWidth, sharedHeight) => {
  const { width, height, data } = source.bitmap;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < sharedWidth && y < sharedHeight) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const idx = (y * width + x) * 4;
      const gray = images.fadedGray(data[idx], data[idx + 1], data[idx + 2]);
      diffImage.setPixelColor(jimp.rgbaToInt(gray, gray, gray, 255), x, y);
    }
  }
};

/**
 * Wrap a shared-region-sized diff into a union-sized image, with single-image areas
 * faded, or return it as-is when both images share dimensions.
 */
images.buildUnionDiffImage = (sharedDiffImage, pair) => {
  if (pair.isSameDimensions) {
    return sharedDiffImage;
  }
  // eslint-disable-next-line new-cap
  const unionDiffImage = new jimp(pair.unionWidth, pair.unionHeight, 0xffffffff);
  images.paintOutsideSharedRegion(unionDiffImage, pair.img1, pair.sharedWidth, pair.sharedHeight);
  images.paintOutsideSharedRegion(unionDiffImage, pair.img2, pair.sharedWidth, pair.sharedHeight);
  unionDiffImage.composite(sharedDiffImage, 0, 0);
  return unionDiffImage;
};

module.exports = images;

const jimp = require('jimp');

const phashStrategy = {};

/**
 * Perceptual-hash comparison: cheap and robust against resizing and compression, useful
 * as a fast "has this view changed at all" gate before running an expensive pixel or
 * SSIM comparison. jimp's distance is the normalised hamming distance between the two
 * perceptual hashes (0 = identical, 1 = completely different).
 *
 * No diff image can be produced from hashes, so this algorithm is only available on the
 * JSON compare endpoints.
 */
phashStrategy.compareStats = async (path1, path2) => {
  const [img1, img2] = await Promise.all([jimp.read(path1), jimp.read(path2)]);
  const distance = jimp.distance(img1, img2);
  const rawMisMatchPercentage = distance * 100;
  return {
    algorithm: 'phash',
    distance: Number(distance.toFixed(4)),
    isSameDimensions: img1.bitmap.width === img2.bitmap.width
      && img1.bitmap.height === img2.bitmap.height,
    dimensionDifference: {
      width: img1.bitmap.width - img2.bitmap.width,
      height: img1.bitmap.height - img2.bitmap.height,
    },
    rawMisMatchPercentage,
    misMatchPercentage: rawMisMatchPercentage.toFixed(2),
  };
};

module.exports = phashStrategy;

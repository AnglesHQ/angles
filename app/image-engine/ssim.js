const path = require('path');
const fsPromises = require('fs').promises;
const jimp = require('jimp');
const { ssim: computeSsim } = require('ssim.js');
const images = require('./images.js');

const ssimStrategy = {};

// How strongly a low-similarity window is highlighted in the diff image.
const HIGHLIGHT_ALPHA = 0.7;

/**
 * Structural similarity comparison. SSIM scores perceptual similarity the way humans do,
 * so anti-aliasing, font hinting and GPU rendering differences barely move it - the top
 * source of flaky pixel comparisons. mssim is in [-1, 1] (1 = identical); the mismatch
 * percentage maps that onto the same 0-100 scale the pixel algorithm reports, clamped
 * because heavily negative scores mean "inverted", which is still just "very different".
 */
const compare = async (path1, path2, options = {}, buildDiffImage = false) => {
  const pair = await images.loadPair(path1, path2);
  images.applyIgnoredBoxes(pair.shared1, pair.shared2, options.ignoredBoxes);

  const { mssim, ssim_map: ssimMap } = computeSsim(pair.shared1.bitmap, pair.shared2.bitmap);
  const rawMisMatchPercentage = Math.min(100, Math.max(0, (1 - mssim) * 100));

  const result = {
    algorithm: 'ssim',
    ssim: Number(mssim.toFixed(4)),
    isSameDimensions: pair.isSameDimensions,
    dimensionDifference: pair.dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage: rawMisMatchPercentage.toFixed(2),
  };

  if (buildDiffImage) {
    // Faded grayscale base with low-similarity windows highlighted in the same magenta
    // as the pixel diff. The SSIM map is smaller than the image (window size 11), so it
    // is sampled with nearest-neighbour mapping.
    // eslint-disable-next-line new-cap
    const sharedDiffImage = new jimp(pair.sharedWidth, pair.sharedHeight, 0xffffffff);
    const sourceData = pair.shared1.bitmap.data;
    for (let y = 0; y < pair.sharedHeight; y += 1) {
      const mapY = Math.min(
        ssimMap.height - 1,
        Math.floor((y / pair.sharedHeight) * ssimMap.height),
      );
      for (let x = 0; x < pair.sharedWidth; x += 1) {
        const mapX = Math.min(
          ssimMap.width - 1,
          Math.floor((x / pair.sharedWidth) * ssimMap.width),
        );
        const similarity = ssimMap.data[mapY * ssimMap.width + mapX];
        const idx = (y * pair.sharedWidth + x) * 4;
        const gray = images.fadedGray(sourceData[idx], sourceData[idx + 1], sourceData[idx + 2]);
        // dissimilarity 0..1 controls the blend towards magenta
        const dissimilarity = Math.min(1, Math.max(0, (1 - similarity))) * HIGHLIGHT_ALPHA;
        const red = Math.round(gray + (255 - gray) * dissimilarity);
        const green = Math.round(gray * (1 - dissimilarity));
        sharedDiffImage.setPixelColor(jimp.rgbaToInt(red, green, red, 255), x, y);
      }
    }
    result.diffImage = images.buildUnionDiffImage(sharedDiffImage, pair);
  }
  return result;
};

const statsOf = (result) => {
  const stats = { ...result };
  delete stats.diffImage;
  return stats;
};

ssimStrategy.compareStats = async (path1, path2, options) => (
  statsOf(await compare(path1, path2, options, false))
);

ssimStrategy.compareAndWriteDiff = async (path1, path2, outputFile, options) => {
  const result = await compare(path1, path2, options, true);
  const buffer = await result.diffImage.getBufferAsync(jimp.MIME_PNG);
  const absolutePath = path.resolve(outputFile);
  await fsPromises.writeFile(absolutePath, buffer);
  return { ...statsOf(result), diffPath: absolutePath };
};

module.exports = ssimStrategy;

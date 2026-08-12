const path = require('path');
const fsPromises = require('fs').promises;
const jimp = require('jimp');
const pixelmatch = require('pixelmatch');
const images = require('./images.js');

const pixel = {};

// Per-pixel colour-distance threshold for pixelmatch (0-1, lower is stricter). 0.5 is the
// value the API has always used, so it stays the default when no threshold is supplied.
const DEFAULT_THRESHOLD = 0.5;
const DIFF_COLOR = [255, 0, 255];
const DIFF_ALPHA = 0.3;

// Diff pixels are clustered on a coarse grid: cells this size are marked when they
// contain a changed pixel, and connected marked cells become one region. Coarse enough
// to merge speckle from the same visual change, fine enough to keep separate changes apart.
const REGION_CELL_SIZE = 16;
const MAX_REGIONS = 50;

/**
 * Cluster changed pixels (exact diff-colour matches in the pixelmatch output) into
 * bounding boxes via connected components on a coarse grid.
 * @returns {Array<Object>} [{ x, y, width, height, pixels }] sorted by pixels desc.
 */
const clusterDiffRegions = (diffBuffer, width, height) => {
  const cellsWide = Math.ceil(width / REGION_CELL_SIZE);
  const cellsHigh = Math.ceil(height / REGION_CELL_SIZE);
  const cellCounts = new Uint32Array(cellsWide * cellsHigh);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      if (diffBuffer[idx] === DIFF_COLOR[0]
        && diffBuffer[idx + 1] === DIFF_COLOR[1]
        && diffBuffer[idx + 2] === DIFF_COLOR[2]) {
        const cellX = Math.floor(x / REGION_CELL_SIZE);
        cellCounts[Math.floor(y / REGION_CELL_SIZE) * cellsWide + cellX] += 1;
      }
    }
  }

  const visited = new Uint8Array(cellsWide * cellsHigh);
  const regions = [];
  for (let cell = 0; cell < cellCounts.length; cell += 1) {
    if (cellCounts[cell] === 0 || visited[cell]) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // Breadth-first flood fill over the 8-connected marked cells.
    let minX = cellsWide;
    let minY = cellsHigh;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;
    const queue = [cell];
    visited[cell] = 1;
    while (queue.length > 0) {
      const current = queue.pop();
      const cx = current % cellsWide;
      const cy = Math.floor(current / cellsWide);
      pixels += cellCounts[current];
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          const ny = cy + dy;
          const neighbour = ny * cellsWide + nx;
          if (nx >= 0 && nx < cellsWide && ny >= 0 && ny < cellsHigh
            && cellCounts[neighbour] > 0 && !visited[neighbour]) {
            visited[neighbour] = 1;
            queue.push(neighbour);
          }
        }
      }
    }
    regions.push({
      x: minX * REGION_CELL_SIZE,
      y: minY * REGION_CELL_SIZE,
      width: Math.min((maxX + 1) * REGION_CELL_SIZE, width) - minX * REGION_CELL_SIZE,
      height: Math.min((maxY + 1) * REGION_CELL_SIZE, height) - minY * REGION_CELL_SIZE,
      pixels,
    });
  }
  return regions.sort((a, b) => b.pixels - a.pixels).slice(0, MAX_REGIONS);
};

/**
 * Compare two images with pixelmatch over the letterboxed shared region.
 * @param {Object} [options] - { ignoredBoxes, threshold, regions }
 * @param {boolean} [buildDiffImage] - also build the union-sized diff image
 */
const compare = async (path1, path2, options = {}, buildDiffImage = false) => {
  const threshold = options.threshold === undefined ? DEFAULT_THRESHOLD : options.threshold;
  const pair = await images.loadPair(path1, path2);
  images.applyIgnoredBoxes(pair.shared1, pair.shared2, options.ignoredBoxes);

  const diffBuffer = Buffer.alloc(pair.sharedWidth * pair.sharedHeight * 4);
  const numDiffPixels = pixelmatch(
    pair.shared1.bitmap.data,
    pair.shared2.bitmap.data,
    diffBuffer,
    pair.sharedWidth,
    pair.sharedHeight,
    { threshold, diffColor: DIFF_COLOR, alpha: DIFF_ALPHA },
  );
  const rawMisMatchPercentage = (numDiffPixels / (pair.sharedWidth * pair.sharedHeight)) * 100;

  const result = {
    algorithm: 'pixel',
    isSameDimensions: pair.isSameDimensions,
    dimensionDifference: pair.dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage: rawMisMatchPercentage.toFixed(2),
    width: pair.unionWidth,
    height: pair.unionHeight,
  };
  if (options.regions) {
    result.regions = clusterDiffRegions(diffBuffer, pair.sharedWidth, pair.sharedHeight);
  }

  if (buildDiffImage) {
    // eslint-disable-next-line new-cap
    const sharedDiffImage = new jimp({
      data: diffBuffer, width: pair.sharedWidth, height: pair.sharedHeight,
    });
    result.diffImage = images.buildUnionDiffImage(sharedDiffImage, pair);
  }
  return result;
};

const statsOf = (result) => {
  const {
    algorithm,
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage,
    regions,
  } = result;
  const stats = {
    algorithm,
    isSameDimensions,
    dimensionDifference,
    rawMisMatchPercentage,
    misMatchPercentage,
  };
  if (regions) stats.regions = regions;
  return stats;
};

/** Compare two image files and return the comparison statistics. */
pixel.compareStats = async (path1, path2, options) => (
  statsOf(await compare(path1, path2, options, false))
);

/**
 * Compare two image files, write the diff PNG to outputFile, and return the statistics
 * plus the absolute path of the written file.
 */
pixel.compareAndWriteDiff = async (path1, path2, outputFile, options) => {
  const result = await compare(path1, path2, options, true);
  const buffer = await result.diffImage.getBufferAsync(jimp.MIME_PNG);
  const absolutePath = path.resolve(outputFile);
  await fsPromises.writeFile(absolutePath, buffer);
  return { ...statsOf(result), diffPath: absolutePath };
};

module.exports = pixel;

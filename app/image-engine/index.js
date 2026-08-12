const pool = require('./worker-pool.js');

/**
 * Public interface of the image engine. Every CPU-heavy operation runs on the worker
 * pool so a large comparison or template search never blocks the event loop; callers
 * get plain result objects back, and errors keep their statusCode across the thread
 * boundary.
 */
const engine = {};

/** Pixel comparison (pixelmatch) - statistics only. Options: { ignoredBoxes, threshold }. */
engine.compareStats = (path1, path2, options) => pool.runTask('pixel-compare', { path1, path2, options });

/** Pixel comparison that also writes the diff PNG to outputFile. */
engine.compareAndWriteDiff = (path1, path2, outputFile, options) => pool.runTask('pixel-compare-image', {
  path1, path2, outputFile, options,
});

/** Multi-scale template matching. templateSource is a file path or Buffer. */
engine.findTemplate = (imagePath, templateSource, options) => pool.runTask('find-template', {
  imagePath, templateSource, options,
});

module.exports = engine;

const featureConfig = require('../../config/feature.config.js');

/**
 * Blocks a route group when its feature toggle is off.
 *
 * 404 rather than 403: a disabled feature does not exist on this instance, and saying
 * "forbidden" would imply the caller could be granted access to it. It also matches how
 * the UI treats the pages - they are gone, not locked.
 *
 * The toggle is read from the in-memory featureConfig, which the feature-settings service
 * keeps current, so this costs no database round trip.
 */
exports.requireManualTesting = (req, res, next) => {
  if (featureConfig.manualTestingEnabled === false) {
    return res.status(404).json({ error: 'Manual test case management is not enabled on this instance.' });
  }
  return next();
};

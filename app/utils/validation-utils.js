const validationUtils = {};

/*
Escapes every regular-expression metacharacter in a string so it can be safely interpolated
into a MongoDB $regex. Without this, user-supplied input is evaluated as a pattern by the
database: a value such as "(a+)+$" triggers catastrophic backtracking (a denial of service
against the database itself), and metacharacters can widen a prefix match to return
documents the caller was not meant to see.
 */
validationUtils.escapeRegex = (value) => `${value}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
This function can be used to ensure the baseline platform and the screenshot platform match.
 */
validationUtils.doPlatformDetailsMatch = (baseline, screenshot) => {
  if (baseline.platform.platformName !== screenshot.platform.platformName) {
    return false;
  }
  if (baseline.platform.deviceName !== undefined) {
    // we compare the platform names
    if (baseline.platform.deviceName === screenshot.platform.deviceName) {
      return true;
    }
    return false;
  }
  if (baseline.platform.browserName !== undefined) {
    if (baseline.platform.browserName === screenshot.platform.browserName
    && baseline.screenHeight === screenshot.height
    && baseline.screenWidth === screenshot.width) {
      return true;
    }
  }
  return false;
};

validationUtils.screenshotHasValidPlatformDetails = ({ platform }) => {
  // a platform name must be provided (and a device name or browser name)
  if (platform.platformName !== undefined
    && (platform.deviceName !== undefined || platform.browserName !== undefined)) {
    return true;
  }
  return false;
};

/* platformId will allow for quicker identifications of what platform a screenshot was taken on */
validationUtils.generatePlatformId = (platform, screenshot) => {
  if (platform.deviceName) {
    /* if device name is given we assume it's a mobile device */
    return `${platform.platformName}_${platform.deviceName}`.toLowerCase();
  }
  if (platform.browserName) {
    /* otherwise we assume it's desktop and use the browser/resolution combination */
    return `${platform.platformName}_${platform.browserName}_${screenshot.width}x${screenshot.height}`.toLowerCase();
  }
  return undefined;
};

validationUtils.returnUniqueDocumentIds = (documents) => {
  const documentIds = documents.map((document) => document._id.toString());
  return Array.from(new Set(documentIds));
};

module.exports = validationUtils;

const crypto = require('crypto');

/**
 * Short stable hash of the options a cached result was generated with. Cached compare and
 * find images embed this in their filename, so a request with different parameters can
 * never be served a stale image generated with other settings.
 */
const optionsHash = (options) => crypto
  .createHash('md5')
  .update(JSON.stringify(options || {}))
  .digest('hex')
  .substring(0, 8);

module.exports = { optionsHash };

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Screenshots are always written beneath this directory. It is resolved from __dirname
// (not the process CWD) so it matches image-utils.removeScreenshotDirectories and stays
// correct regardless of where the process was started from.
const SCREENSHOT_ROOT = path.resolve(__dirname, '../../screenshots');

// multer joins destination + filename with no sanitising of its own, and `originalname`
// is attacker-controlled, so both halves have to be constrained here. The buildId is also
// validated by express-validator on the route, but that runs *after* multer has already
// written the file to disk, so it cannot be relied on for this.
const MONGO_ID_PATTERN = /^[a-f\d]{24}$/i;

// The upload is only accepted for mime types we can map to a known-safe extension; the
// client filename is discarded entirely rather than sanitised.
const EXTENSION_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
};

const multerConfig = multer({
  limits: { fileSize: 10485760 },
  storage: multer.diskStorage({
    destination(req, file, next) {
      const { buildId } = req.body;
      if (!MONGO_ID_PATTERN.test(buildId || '')) {
        return next(new Error('A valid buildId is required to upload a screenshot'));
      }
      const directory = path.join(SCREENSHOT_ROOT, buildId);
      // Defence in depth: even with the pattern above, never write outside the root.
      if (directory !== SCREENSHOT_ROOT && !directory.startsWith(SCREENSHOT_ROOT + path.sep)) {
        return next(new Error('A valid buildId is required to upload a screenshot'));
      }
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }
      return next(null, directory);
    },
    filename(req, file, next) {
      const extension = EXTENSION_BY_MIME[file.mimetype];
      if (!extension) {
        return next(new Error('Only image files are supported'));
      }
      const unique = crypto.randomBytes(8).toString('hex');
      return next(null, `${Date.now()}-${unique}${extension}`);
    },
  }),
  fileFilter(req, file, next) {
    if (!file) {
      return next(null, false);
    }
    if (Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME, file.mimetype)) {
      return next(null, true);
    }
    return next(new Error('Only image files are supported'));
  },
});

module.exports = multerConfig;

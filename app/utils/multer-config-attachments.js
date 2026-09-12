const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Attachments are always written beneath this directory. Resolved from __dirname (not the
// process CWD) so it matches attachment-utils and stays correct regardless of where the
// process was started from.
const ATTACHMENT_ROOT = path.resolve(__dirname, '../../attachments');

// multer joins destination + filename with no sanitising of its own, and `originalname`
// is attacker-controlled, so both halves have to be constrained here. The owner id is
// also validated by express-validator on the route, but that runs *after* multer has
// already written the file to disk, so it cannot be relied on for this.
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

// Files are grouped by the entity they belong to, so deleting that entity is a single
// recursive remove of one directory - the same shape as screenshots/<buildId>.
const ownerIdFor = (body) => body.testCaseId || body.sharedStepId || body.executionId;

const multerConfig = multer({
  limits: { fileSize: 10485760 },
  storage: multer.diskStorage({
    destination(req, file, next) {
      const ownerId = ownerIdFor(req.body);
      if (!MONGO_ID_PATTERN.test(ownerId || '')) {
        return next(new Error('A valid testCaseId, sharedStepId or executionId is required to upload an attachment'));
      }
      const directory = path.join(ATTACHMENT_ROOT, ownerId);
      // Defence in depth: even with the pattern above, never write outside the root.
      if (directory !== ATTACHMENT_ROOT && !directory.startsWith(ATTACHMENT_ROOT + path.sep)) {
        return next(new Error('A valid testCaseId, sharedStepId or executionId is required to upload an attachment'));
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
module.exports.ATTACHMENT_ROOT = ATTACHMENT_ROOT;

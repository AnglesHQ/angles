const multer = require('multer');

// Templates uploaded for an ad-hoc "find image in screenshot" search are transient: they
// are matched straight from the request buffer and never written to disk, so memory
// storage is used instead of the diskStorage the screenshot upload needs.
const SUPPORTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
];

const multerConfig = multer({
  limits: { fileSize: 10485760 },
  storage: multer.memoryStorage(),
  fileFilter(req, file, next) {
    if (!file) {
      return next(null, false);
    }
    if (SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
      return next(null, true);
    }
    return next(new Error('Only image files are supported'));
  },
});

module.exports = multerConfig;

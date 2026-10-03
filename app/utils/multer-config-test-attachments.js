const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ATTACHMENT_ROOT } = require('./multer-config-attachments.js');

// Files an automated test uploads against a build: console logs, HAR files, videos,
// Playwright traces, HTML snapshots and plain images. Stored beside the manual-testing
// attachments, grouped by build id so deleting a build is one recursive remove (the same
// shape as screenshots/<buildId>).
//
// The build id comes from the URL (POST /build/:buildId/attachment) rather than a form
// field, so it is available before multer writes the file regardless of the order the
// client put the multipart fields in.
const MONGO_ID_PATTERN = /^[a-f\d]{24}$/i;

// Default 100 MB: a test video or a trace can be tens of megabytes. Configurable because
// the right ceiling depends on how long a team's tests run and how much disk they have.
const DEFAULT_MAX_SIZE_MB = 100;
const configuredMaxSize = Number(process.env.ANGLES_ATTACHMENT_MAX_SIZE_MB);
const MAX_SIZE_MB = Number.isFinite(configuredMaxSize) && configuredMaxSize > 0
  ? configuredMaxSize : DEFAULT_MAX_SIZE_MB;

// Everything the server knows about a file comes from this table, keyed by the extension
// of the client's filename. The client's mime type is ignored: test frameworks report
// `application/octet-stream` for most of these, and the mime type stored here is what the
// file is served with later, so it must not be attacker-chosen.
const TYPES_BY_EXTENSION = {
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.log': { kind: 'log', mimeType: 'text/plain' },
  '.txt': { kind: 'log', mimeType: 'text/plain' },
  '.json': { kind: 'json', mimeType: 'application/json' },
  '.har': { kind: 'har', mimeType: 'application/json' },
  '.webm': { kind: 'video', mimeType: 'video/webm' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.zip': { kind: 'archive', mimeType: 'application/zip' },
  '.html': { kind: 'html', mimeType: 'text/html' },
  '.htm': { kind: 'html', mimeType: 'text/html' },
};

/**
 * Decides how a test attachment is stored and shown, from the client's filename alone.
 * Returns undefined for an extension that is not supported.
 *
 * A zip whose name mentions "trace" is treated as a Playwright trace (Playwright names
 * them trace.zip); any other zip is a plain archive offered for download.
 */
const describeFile = (originalName) => {
  const base = path.basename(originalName || '').toLowerCase();
  const extension = path.extname(base);
  const type = TYPES_BY_EXTENSION[extension];
  if (!type) {
    return undefined;
  }
  const kind = type.kind === 'archive' && base.includes('trace') ? 'trace' : type.kind;
  return { ...type, kind, extension: extension === '.jpeg' ? '.jpg' : extension };
};

const SUPPORTED_EXTENSIONS = Object.keys(TYPES_BY_EXTENSION).join(', ');
const unsupportedError = () => new Error(`Unsupported attachment type. Supported file extensions: ${SUPPORTED_EXTENSIONS}`);

const multerConfig = multer({
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  storage: multer.diskStorage({
    destination(req, file, next) {
      const { buildId } = req.params;
      if (!MONGO_ID_PATTERN.test(buildId || '')) {
        return next(new Error('A valid buildId is required to upload an attachment'));
      }
      const directory = path.join(ATTACHMENT_ROOT, buildId);
      // Defence in depth: even with the pattern above, never write outside the root.
      if (!directory.startsWith(ATTACHMENT_ROOT + path.sep)) {
        return next(new Error('A valid buildId is required to upload an attachment'));
      }
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }
      return next(null, directory);
    },
    filename(req, file, next) {
      const description = describeFile(file.originalname);
      if (!description) {
        return next(unsupportedError());
      }
      // The client's filename is never used to build a path; only the extension it maps
      // to, which comes from the table above.
      const unique = crypto.randomBytes(8).toString('hex');
      return next(null, `${Date.now()}-${unique}${description.extension}`);
    },
  }),
  fileFilter(req, file, next) {
    if (!file) {
      return next(null, false);
    }
    if (describeFile(file.originalname)) {
      return next(null, true);
    }
    return next(unsupportedError());
  },
});

module.exports = multerConfig;
module.exports.describeFile = describeFile;
module.exports.MAX_SIZE_MB = MAX_SIZE_MB;

const multer = require('multer');
const fs = require('fs');

const multerConfig = multer({
  limits: { fileSize: 10485760 },
  storage: multer.diskStorage({
    destination(req, file, next) {
      const directory = `screenshots/${req.body.buildId}`;
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory);
      }
      next(null, directory);
    },
    filename(reg, file, next) {
      next(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  fileFilter(req, file, next) {
    if (!file) {
      next();
    }
    const image = file.mimetype.startsWith('image/');
    if (image) {
      return next(null, true);
    }
    return next(new Error('Only image files are supported'));
  },
});

module.exports = multerConfig;

const multer = require('multer');

const multerConfig = multer({
  dest: 'screenshots',
  filename(reg, file, next) {
    const ext = file.mimetype.split('/')[1];
    next(null, `${file.originalname}-${Date.now()}.${ext}`);
    // next(null, `${Date.now()}-${file.originalname}`);
    // next(null, file.originalname);
  },
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

// const multerConfig = {
//   storage: multer.diskStorage({
//     destination(req, file, next) {
//       next(null, 'screenshots');
//     },
//     // then give the file a unique name here
//     filename(reg, file, next) {
//       console.log(file);
//       const ext = file.mimetype.split('/')[1];
//       next(null, `${file.originalname}-${Date.now()}.${ext}`);
//       next(null, `${Date.now()}-${file.originalname}`);
//       next(null, file.originalname);
//     },
//   }),
//
//   // a means of ensuring only images are uploaded.
//   fileFilter(req, file, next) {
//     if (!file) {
//       next();
//     }
//     const image = file.mimetype.startsWith('image/');
//     if (image) {
//       // image uploaded
//       return next(null, true);
//     }
//     return next(new Error('File not supported'));
//   },
// };

module.exports = multerConfig;

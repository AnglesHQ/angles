const {
  check,
  param,
  query,
  oneOf,
} = require('express-validator');
const multerConfig = require('../utils/multer-config-attachments.js');
const testAttachmentMulter = require('../utils/multer-config-test-attachments.js');
const attachmentController = require('../controllers/attachment.controller.js');

module.exports = (app, path) => {
  app.post(
    `${path}/attachment`,
    multerConfig.single('attachment'),
    [
      // Exactly one owner is required. multer has already validated the id's shape before
      // writing the file (it builds the directory from it), but the request is only
      // accepted once express-validator confirms it here too.
      oneOf([
        check('testCaseId').exists().isMongoId(),
        check('sharedStepId').exists().isMongoId(),
        check('executionId').exists().isMongoId(),
      ], 'A valid testCaseId, sharedStepId or executionId is required'),
    ],
    attachmentController.create,
    attachmentController.createFail,
  );

  // A file an automated test uploads while it runs: log, HAR, video, trace, HTML snapshot
  // or image. The build id is in the path so multer has it before writing the file.
  app.post(
    `${path}/build/:buildId/attachment`,
    testAttachmentMulter.single('attachment'),
    [
      param('buildId').exists().isMongoId(),
    ],
    attachmentController.createForBuild,
    attachmentController.createFail,
  );

  app.get(`${path}/attachment`, [
    oneOf([
      query('testCaseId').exists().isMongoId(),
      query('sharedStepId').exists().isMongoId(),
      query('executionId').exists().isMongoId(),
      query('buildId').exists().isMongoId(),
    ], 'A valid testCaseId, sharedStepId, executionId or buildId is required'),
  ], attachmentController.findAll);

  // `?download=true` serves any attachment as a download instead of inline.
  // (Build-scoped HTML snapshots, traces and archives are always downloads.)

  app.get(`${path}/attachment/:attachmentId`, [
    param('attachmentId').exists().isMongoId(),
  ], attachmentController.findOne);

  app.get(`${path}/attachment/:attachmentId/file`, [
    param('attachmentId').exists().isMongoId(),
  ], attachmentController.findFile);

  app.get(`${path}/attachment/:attachmentId/thumbnail`, [
    param('attachmentId').exists().isMongoId(),
  ], attachmentController.findThumbnail);

  app.delete(`${path}/attachment/:attachmentId`, [
    param('attachmentId').exists().isMongoId(),
  ], attachmentController.delete);
};

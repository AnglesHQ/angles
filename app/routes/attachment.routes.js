const {
  check,
  param,
  query,
  oneOf,
} = require('express-validator');
const multerConfig = require('../utils/multer-config-attachments.js');
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

  app.get(`${path}/attachment`, [
    oneOf([
      query('testCaseId').exists().isMongoId(),
      query('sharedStepId').exists().isMongoId(),
    ], 'A valid testCaseId or sharedStepId is required'),
  ], attachmentController.findAll);

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

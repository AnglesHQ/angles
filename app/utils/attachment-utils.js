const fs = require('fs');
const path = require('path');
const debug = require('debug');
const { rimraf } = require('rimraf');
const jimp = require('jimp');
const Attachment = require('../models/attachment.js');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');
const { ATTACHMENT_ROOT } = require('./multer-config-attachments.js');

const log = debug('attachment:utils');
const attachmentUtils = {};

attachmentUtils.ATTACHMENT_ROOT = ATTACHMENT_ROOT;

const THUMBNAIL_MAX = 300;

/*
Writes a .thumb.png beside the original and returns { thumbnail, width, height }.

The thumbnail is a file rather than a base64 string on the document (which is what
Screenshot does): a test case with thirty attachments would otherwise carry thirty base64
blobs in a single response, and the authoring UI lists them constantly.

A file that cannot be read as an image still yields a usable attachment - the original is
served either way - so failure here is logged and the thumbnail left unset rather than
failing the upload.
 */
attachmentUtils.generateThumbnail = async (filePath) => {
  try {
    const image = await jimp.read(filePath);
    const { width, height } = image.bitmap;
    const thumbnailPath = `${filePath}.thumb.png`;
    await image
      .scaleToFit(THUMBNAIL_MAX, THUMBNAIL_MAX)
      .quality(72)
      .writeAsync(thumbnailPath);
    return { thumbnail: thumbnailPath, width, height };
  } catch (error) {
    log(`Could not generate a thumbnail for ${filePath}: ${error.message}`);
    return {};
  }
};

/*
Counts the frozen versions whose steps reference this attachment.

This is the check that makes an attachment immutable once a version has been written: a
historical execution has to render the image the tester actually saw, and the file is the
only copy of it.
 */
attachmentUtils.countVersionReferences = (attachmentId) => ManualTestCaseVersion
  .countDocuments({ 'steps.attachments': attachmentId })
  .exec();

/*
Removes an attachment's files from disk. Missing files are not an error - the document is
the record of truth and a half-removed upload should still be collectable.
 */
attachmentUtils.removeFiles = async (attachment) => {
  const targets = [attachment.path, attachment.thumbnail].filter(Boolean);
  await Promise.all(targets.map(async (target) => {
    const resolved = path.resolve(target);
    // Never unlink outside the attachment root, whatever the stored path says.
    if (!resolved.startsWith(ATTACHMENT_ROOT + path.sep)) {
      log(`Refusing to remove a file outside the attachment root: ${resolved}`);
      return;
    }
    try {
      await fs.promises.unlink(resolved);
      log(`Removed attachment file ${resolved}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log(`Could not remove ${resolved}: ${error.message}`);
      }
    }
  }));
};

/*
Removes an entity's attachment directory if it is empty.

multer creates the directory in its `destination` handler, before the request has been
authorised or the owner confirmed to exist, so a rejected upload leaves an empty directory
behind. Only removed when empty, so this can never take a concurrent upload's files with
it.
 */
attachmentUtils.removeDirectoryIfEmpty = async (directory) => {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(ATTACHMENT_ROOT + path.sep)) {
    return;
  }
  try {
    const entries = await fs.promises.readdir(resolved);
    if (entries.length === 0) {
      await fs.promises.rmdir(resolved);
      log(`Removed empty attachment directory ${resolved}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log(`Could not tidy ${resolved}: ${error.message}`);
    }
  }
};

/*
Removes the whole attachment directory for an entity, mirroring
imageUtils.removeScreenshotDirectories.

Used when a test case or shared step is deleted: its versions go first, so nothing
references the attachments by then.
 */
attachmentUtils.removeAttachmentDirectory = async (ownerId) => {
  const directory = path.join(ATTACHMENT_ROOT, ownerId.toString());
  // This is a recursive delete, so never let a malformed id escape the attachment root.
  if (!directory.startsWith(ATTACHMENT_ROOT + path.sep)) {
    log(`Refusing to remove directory outside the attachment root: ${directory}`);
    return;
  }
  await rimraf(directory);
  log(`Removed attachment directory ${directory}`);
};

/*
Deletes every attachment belonging to an entity, files and documents alike.

Called after the entity's frozen versions have been removed, so the immutability rule that
protects a referenced attachment no longer applies - the thing that referenced it is gone.
 */
attachmentUtils.removeAttachmentsForOwner = async (scope, ownerId) => {
  const field = { testcase: 'testCase', sharedstep: 'sharedStep', execution: 'manualExecution' }[scope];
  const result = await Attachment.deleteMany({ [field]: ownerId }).exec();
  await attachmentUtils.removeAttachmentDirectory(ownerId);
  return result.deletedCount || 0;
};

module.exports = attachmentUtils;

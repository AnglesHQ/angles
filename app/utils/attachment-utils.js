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

// ── Build-scoped attachments (files uploaded by automated tests) ─────────────

// Kinds that are always downloaded rather than shown inline when opened directly. An HTML
// snapshot opened inline on the API's origin would run its scripts with the viewer's
// session cookie; archives have nothing to show inline.
const DOWNLOAD_ONLY_KINDS = ['html', 'trace', 'archive'];

// Keeps a stored display name safe inside a Content-Disposition header.
const dispositionFilename = (name) => (name || 'attachment').replace(/[^\w.\- ]+/g, '_');

/*
Headers for serving an attachment's file.

Every file is served with `nosniff`, so a browser never second-guesses the stored type,
and with a `sandbox` CSP, so even a file a browser does render (an HTML snapshot opened
from a link, an SVG inside a zip viewer) runs in an opaque origin with scripts disabled.
The UI fetches files with XHR and renders HTML in a sandboxed iframe of its own, so none
of this changes what it shows.
 */
attachmentUtils.fileHeaders = (attachment, download) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  };
  if (attachment.scope !== 'build') {
    return headers;
  }
  headers['Content-Type'] = attachment.mimeType || 'application/octet-stream';
  const disposition = download || DOWNLOAD_ONLY_KINDS.includes(attachment.kind) ? 'attachment' : 'inline';
  headers['Content-Disposition'] = `${disposition}; filename="${dispositionFilename(attachment.originalName)}"`;
  return headers;
};

// The fields a reader of an execution needs to list and open its attachments. `path` and
// `filename` are deliberately left out: they are server paths, not something to hand out.
attachmentUtils.PUBLIC_FIELDS = '_id kind originalName mimeType size execution build createdAt';

const idsOf = (list) => (list || []).map((id) => id.toString());

// Every attachment id an execution references, at execution level and on its steps.
const referencedIds = (execution) => {
  const ids = idsOf(execution.attachments);
  (execution.actions || []).forEach((action) => {
    (action.steps || []).forEach((step) => ids.push(...idsOf(step.attachments)));
  });
  return ids;
};
attachmentUtils.referencedIds = referencedIds;

/*
Drops any attachment id that was not uploaded against the execution's own build.

An execution can only claim files from its own build. Without this a caller could list
another team's attachment id on their execution and read its name and size back through
the execution's attachment list (the file itself is still guarded by a team check).
Unknown ids are dropped rather than rejected, matching how a missing screenshot id on a
step is tolerated: the test results are worth more than a stale reference.

Updates the (unsaved) execution documents in place.
 */
attachmentUtils.restrictToBuild = async (executions, buildId) => {
  const allIds = [...new Set(executions.flatMap(referencedIds))];
  if (allIds.length === 0) {
    return;
  }
  const valid = await Attachment.find({ _id: { $in: allIds }, build: buildId, scope: 'build' })
    .distinct('_id')
    .exec();
  const validIds = new Set(valid.map((id) => id.toString()));
  if (validIds.size < allIds.length) {
    log(`Dropping ${allIds.length - validIds.size} attachment reference(s) that do not belong to build ${buildId}`);
  }
  const keep = (list) => (list || []).filter((id) => validIds.has(id.toString()));
  executions.forEach((execution) => {
    execution.set('attachments', keep(execution.attachments));
    (execution.actions || []).forEach((action) => {
      (action.steps || []).forEach((step) => {
        if (step.attachments && step.attachments.length) {
          step.set('attachments', keep(step.attachments));
        }
      });
    });
  });
};

/*
Records which execution each referenced attachment now belongs to, once the executions
are saved. This is what lets the attachment list for an execution be a single indexed
query, and what removes an execution's files when the execution is deleted.
 */
attachmentUtils.linkToExecutions = async (executions) => {
  await Promise.all(executions.map((execution) => {
    const ids = referencedIds(execution);
    if (ids.length === 0) {
      return undefined;
    }
    return Attachment.updateMany(
      { _id: { $in: ids }, build: execution.build, scope: 'build' },
      { $set: { execution: execution._id } },
    ).exec();
  }));
};

/*
Removes the build-scoped attachments of the given builds: documents and directories.
Called wherever builds are deleted, alongside removeScreenshotDirectories.
 */
attachmentUtils.removeAttachmentsForBuilds = async (buildIds) => {
  if (!buildIds || buildIds.length === 0) {
    return 0;
  }
  const result = await Attachment.deleteMany({ build: { $in: buildIds }, scope: 'build' }).exec();
  await Promise.all(buildIds.map((buildId) => attachmentUtils.removeAttachmentDirectory(buildId)));
  return result.deletedCount || 0;
};

/*
Removes the attachments an execution claimed, files and documents. Files no execution has
claimed stay with the build and go when the build does.
 */
attachmentUtils.removeAttachmentsForExecution = async (executionId) => {
  const attachments = await Attachment.find({ execution: executionId, scope: 'build' }).lean().exec();
  await Promise.all(attachments.map((attachment) => attachmentUtils.removeFiles(attachment)));
  await Attachment.deleteMany({ execution: executionId, scope: 'build' }).exec();
  return attachments.length;
};

module.exports = attachmentUtils;

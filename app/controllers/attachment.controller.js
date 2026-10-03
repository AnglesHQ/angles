const path = require('path');
const { validationResult } = require('express-validator');
const debug = require('debug');

const Attachment = require('../models/attachment.js');
const Build = require('../models/build.js');
const TestExecution = require('../models/execution.js');
const ManualTestCase = require('../models/manual-test-case.js');
const SharedStep = require('../models/shared-step.js');
const attachmentUtils = require('../utils/attachment-utils.js');
const { describeFile } = require('../utils/multer-config-test-attachments.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('attachment:controller');

// Resolves the entity an upload is being attached to, and the team that owns it. The team
// comes from the entity rather than the request so a caller cannot claim an attachment
// belongs to a team they happen to have access to.
const resolveOwner = async (body) => {
  const { testCaseId, sharedStepId, executionId } = body;
  if (testCaseId) {
    const testCase = await ManualTestCase.findById(testCaseId).select('_id team').lean().exec();
    if (!testCase) {
      throw new NotFoundError(`No manual test case found with id ${testCaseId}`);
    }
    return { scope: 'testcase', field: 'testCase', owner: testCase };
  }
  if (sharedStepId) {
    const sharedStep = await SharedStep.findById(sharedStepId).select('_id team').lean().exec();
    if (!sharedStep) {
      throw new NotFoundError(`No shared step found with id ${sharedStepId}`);
    }
    return { scope: 'sharedstep', field: 'sharedStep', owner: sharedStep };
  }
  // Manual executions arrive in phase 6; the upload path already accepts them.
  throw new NotFoundError(`No attachable entity found with id ${executionId}`);
};

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  if (!req.file) {
    return res.status(400).send({ message: 'An image file is required in the "attachment" field.' });
  }

  return resolveOwner(req.body)
    .then(async ({ scope, field, owner }) => {
      if (!authMiddleware.hasTeamAccess(req.user, owner.team)) {
        throw new ForbiddenError('You do not have access to this team');
      }

      const { thumbnail, width, height } = await attachmentUtils
        .generateThumbnail(req.file.path);

      const attachment = new Attachment({
        team: owner.team,
        scope,
        [field]: owner._id,
        filename: req.file.filename,
        // Display only - never used to build a path, and stripped of any directory
        // component the client may have included.
        originalName: path.basename(req.file.originalname || ''),
        mimeType: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
        thumbnail,
        width,
        height,
        uploadedBy: req.user ? req.user._id : undefined,
      });
      const saved = await attachment.save();
      log(`Stored attachment ${saved._id} for ${scope} ${owner._id}`);
      return saved;
    })
    .then((saved) => res.status(201).send(saved))
    .catch(async (err) => {
      // The file is already on disk by the time any of this runs, so a rejected upload
      // must not leave it orphaned there. multer also created the directory before the
      // request was authorised, so tidy that away too when nothing else landed in it.
      if (req.file) {
        await attachmentUtils.removeFiles({ path: req.file.path });
        await attachmentUtils.removeDirectoryIfEmpty(path.dirname(req.file.path));
      }
      return handleError(err, res);
    });
};

/*
Stores a file an automated test uploaded against a build: a console log, HAR file, video,
Playwright trace, HTML snapshot or image. The test lists the returned id on the execution
(or a step) when it saves the execution, and the attachment is linked to it then.
 */
exports.createForBuild = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  if (!req.file) {
    return res.status(400).send({ message: 'A file is required in the "attachment" field.' });
  }
  const { buildId } = req.params;

  return Build.findById(buildId).select('_id team').lean().exec()
    .then(async (build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, build.team)) {
        throw new ForbiddenError('You do not have access to this build');
      }
      // multer has already accepted the extension, so this always describes the file.
      const { kind, mimeType } = describeFile(req.file.originalname);
      const imageDetails = kind === 'image'
        ? await attachmentUtils.generateThumbnail(req.file.path) : {};

      const attachment = new Attachment({
        team: build.team,
        scope: 'build',
        build: build._id,
        kind,
        filename: req.file.filename,
        originalName: path.basename(req.file.originalname || ''),
        mimeType,
        size: req.file.size,
        path: req.file.path,
        ...imageDetails,
        uploadedBy: req.user ? req.user._id : undefined,
      });
      const saved = await attachment.save();
      log(`Stored ${kind} attachment ${saved._id} for build ${build._id}`);
      return Attachment.findById(saved._id).select(attachmentUtils.PUBLIC_FIELDS).lean().exec();
    })
    .then((saved) => res.status(201).send(saved))
    .catch(async (err) => {
      if (req.file) {
        await attachmentUtils.removeFiles({ path: req.file.path });
        await attachmentUtils.removeDirectoryIfEmpty(path.dirname(req.file.path));
      }
      return handleError(err, res);
    });
};

// Express only treats a middleware as an error handler when it declares four parameters,
// so `next` must stay in the signature even though it is unused - without it multer's
// rejections (bad mime type, missing owner id) fall through to the default handler and
// are returned as a 500 with an HTML stack trace instead of this 400.
// eslint-disable-next-line no-unused-vars
exports.createFail = (error, req, res, next) => res.status(400).send({ error: error.message });

// Resolves the team behind a build-scoped listing: the build itself, or the build an
// automated execution belongs to.
const resolveBuildListing = async ({ executionId, buildId }) => {
  if (executionId) {
    const execution = await TestExecution.findById(executionId).select('_id build').lean().exec();
    if (!execution) {
      throw new NotFoundError(`No execution found with id ${executionId}`);
    }
    const build = await Build.findById(execution.build).select('_id team').lean().exec();
    if (!build) {
      throw new NotFoundError(`No build found for execution with id ${executionId}`);
    }
    return { query: { execution: execution._id, scope: 'build' }, team: build.team };
  }
  const build = await Build.findById(buildId).select('_id team').lean().exec();
  if (!build) {
    throw new NotFoundError(`No build found with id ${buildId}`);
  }
  return { query: { build: build._id, scope: 'build' }, team: build.team };
};

const findBuildAttachments = (req, res) => {
  const { executionId, buildId } = req.query;
  return resolveBuildListing({ executionId, buildId })
    .then(({ query, team }) => {
      if (!authMiddleware.hasTeamAccess(req.user, team)) {
        throw new ForbiddenError('You do not have access to this build');
      }
      return Attachment.find(query)
        .select(attachmentUtils.PUBLIC_FIELDS)
        .sort('createdAt')
        .lean()
        .exec();
    })
    .then((attachments) => res.status(200).send({ attachments }))
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    testCaseId, sharedStepId, executionId, buildId,
  } = req.query;
  if (executionId || buildId) {
    return findBuildAttachments(req, res);
  }

  return resolveOwner({ testCaseId, sharedStepId })
    .then(({ field, owner }) => {
      if (!authMiddleware.hasTeamAccess(req.user, owner.team)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      return Attachment.find({ [field]: owner._id })
        .populate('uploadedBy', 'username')
        .sort('-createdAt')
        .lean()
        .exec();
    })
    .then((attachments) => res.status(200).send({ attachments }))
    .catch((err) => handleError(err, res));
};

const findWithAccess = async (attachmentId, user) => {
  const attachment = await Attachment.findById(attachmentId).lean().exec();
  if (!attachment) {
    throw new NotFoundError(`No attachment found with id ${attachmentId}`);
  }
  if (!authMiddleware.hasTeamAccess(user, attachment.team)) {
    throw new ForbiddenError('You do not have access to this attachment');
  }
  return attachment;
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return findWithAccess(req.params.attachmentId, req.user)
    .then((attachment) => Attachment.findById(attachment._id)
      .populate('uploadedBy', 'username')
      .lean()
      .exec())
    .then((attachment) => res.status(200).send(attachment))
    .catch((err) => handleError(err, res));
};

exports.findFile = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return findWithAccess(req.params.attachmentId, req.user)
    .then((attachment) => res.sendFile(
      path.resolve(attachment.path),
      { headers: attachmentUtils.fileHeaders(attachment, req.query.download === 'true') },
    ))
    .catch((err) => handleError(err, res));
};

exports.findThumbnail = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return findWithAccess(req.params.attachmentId, req.user)
    .then((attachment) => {
      // An image that could not be thumbnailed still has a usable original, so fall back
      // to it rather than 404ing a request the UI makes for every listed attachment.
      const target = attachment.thumbnail || attachment.path;
      return res.sendFile(path.resolve(target));
    })
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { attachmentId } = req.params;

  return findWithAccess(attachmentId, req.user)
    .then(async (attachment) => {
      // An attachment referenced by a frozen version is never removed. Dropping the image
      // from a step in the editor takes it off the head, but the file is the only copy of
      // what a historical execution has to render.
      const references = await attachmentUtils.countVersionReferences(attachment._id);
      if (references > 0) {
        throw new ConflictError(`Unable to delete this attachment as ${references} frozen test case version(s) still reference it. Remove it from the test case instead; the image stays available to the executions that used it.`);
      }

      await attachmentUtils.removeFiles(attachment);
      await Attachment.findByIdAndRemove(attachmentId).exec();

      // Leave no dangling reference on the head - a step pointing at a removed attachment
      // would render as a broken image.
      await ManualTestCase.updateMany(
        { 'steps.attachments': attachment._id },
        { $pull: { 'steps.$[].attachments': attachment._id } },
      ).exec();
      await SharedStep.updateMany(
        { 'steps.attachments': attachment._id },
        { $pull: { 'steps.$[].attachments': attachment._id } },
      ).exec();
      if (attachment.scope === 'build') {
        await TestExecution.updateMany(
          { attachments: attachment._id },
          { $pull: { attachments: attachment._id } },
        ).exec();
        await TestExecution.updateMany(
          { 'actions.steps.attachments': attachment._id },
          { $pull: { 'actions.$[].steps.$[].attachments': attachment._id } },
        ).exec();
      }

      log(`Deleted attachment ${attachmentId}`);
      return true;
    })
    .then(() => res.status(200).send({ message: 'Attachment deleted successfully!' }))
    .catch((err) => handleError(err, res));
};

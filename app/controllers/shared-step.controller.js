const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');

const SharedStep = require('../models/shared-step.js');
const ManualTestCase = require('../models/manual-test-case.js');
const { Team } = require('../models/team.js');
const sharedStepUtils = require('../utils/shared-step-utils.js');
const manualTestCaseUtils = require('../utils/manual-test-case-utils.js');
const attachmentUtils = require('../utils/attachment-utils.js');
const validationUtils = require('../utils/validation-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidRequestError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('shared-step:controller');

// A shared step's own steps are always literal. Allowing one to include another would make
// expansion recursive and open the door to a reference cycle, for no real gain - an author
// wanting a longer sequence can add the steps directly.
const rejectNestedSharedSteps = (steps) => {
  const nested = (steps || []).filter((step) => step.sharedStep);
  if (nested.length > 0) {
    throw new InvalidRequestError('A shared step cannot include another shared step.');
  }
};

const normaliseSteps = (steps) => (steps || []).map((step, index) => ({
  ...step,
  order: step.order === undefined ? index + 1 : step.order,
}));

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    team, name, description, steps,
  } = req.body;

  return Team.findById(team).select('_id name').lean().exec()
    .then(async (teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${team}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, teamFound._id)) {
        throw new ForbiddenError('You do not have permission to manage shared steps for this team');
      }
      rejectNestedSharedSteps(steps);

      // Checked explicitly so the caller gets a 409 naming the collision rather than a
      // driver error. The unique index remains the backstop against a concurrent create.
      const existing = await SharedStep.findOne({ team: teamFound._id, name }).lean().exec();
      if (existing) {
        throw new ConflictError(`A shared step named "${name}" already exists for this team.`);
      }

      const sharedStep = new SharedStep({
        team: teamFound._id,
        name,
        description,
        steps: normaliseSteps(steps),
        version: 1,
        createdBy: req.user ? req.user._id : undefined,
        updatedBy: req.user ? req.user._id : undefined,
      });
      const saved = await sharedStep.save();
      log(`Created shared step "${name}" for team ${teamFound._id}`);
      return saved;
    })
    .then((saved) => SharedStep.findById(saved._id)
      .populate('createdBy', 'username')
      .populate('updatedBy', 'username')
      .lean()
      .exec())
    .then((saved) => res.status(201).send(saved))
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, search } = req.query;
  const limit = parseInt(req.query.limit, 10) || 25;
  const skip = parseInt(req.query.skip, 10) || 0;

  return Team.findById(teamId).select('_id').lean().exec()
    .then((teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${teamId}`);
      }
      // Readable by any team member - authors need to browse the library to include a
      // step. Only writes require team lead access.
      if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      const query = { team: mongoose.Types.ObjectId(teamId) };
      if (search) {
        const escaped = validationUtils.escapeRegex(search);
        query.$or = [
          { name: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } },
        ];
      }
      return Promise.all([
        SharedStep.find(query, null, { limit, skip })
          .populate('updatedBy', 'username')
          .sort('-updatedAt')
          .lean()
          .exec(),
        SharedStep.countDocuments(query).exec(),
      ]);
    })
    .then((results) => res.status(200).send({
      sharedSteps: results[0],
      metrics: { totalSharedSteps: results[1] },
    }))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { sharedStepId } = req.params;

  return SharedStep.findById(sharedStepId)
    .populate('createdBy', 'username')
    .populate('updatedBy', 'username')
    .lean()
    .exec()
    .then((sharedStep) => {
      if (!sharedStep) {
        throw new NotFoundError(`No shared step found with id ${sharedStepId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, sharedStep.team)) {
        throw new ForbiddenError('You do not have access to this shared step');
      }
      return res.status(200).send(sharedStep);
    })
    .catch((err) => handleError(err, res));
};

/*
Lists the test cases that include this shared step, so the UI can warn an author how many
cases an edit is about to version before they commit to it.
 */
exports.findUsage = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { sharedStepId } = req.params;

  return SharedStep.findById(sharedStepId).lean().exec()
    .then((sharedStep) => {
      if (!sharedStep) {
        throw new NotFoundError(`No shared step found with id ${sharedStepId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, sharedStep.team)) {
        throw new ForbiddenError('You do not have access to this shared step');
      }
      return ManualTestCase
        .find({ 'steps.sharedStep': sharedStep._id })
        .select('_id title status version')
        .sort('title')
        .lean()
        .exec();
    })
    .then((testCases) => res.status(200).send({
      testCases,
      metrics: { totalTestCases: testCases.length },
    }))
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { sharedStepId } = req.params;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return SharedStep.findById(sharedStepId)
    .then(async (sharedStep) => {
      if (!sharedStep) {
        throw new NotFoundError(`No shared step found with id ${sharedStepId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, sharedStep.team)) {
        throw new ForbiddenError('You do not have permission to manage this shared step');
      }
      if (req.body.steps !== undefined) {
        rejectNestedSharedSteps(req.body.steps);
      }
      if (req.body.name !== undefined && req.body.name !== sharedStep.name) {
        const clash = await SharedStep
          .findOne({ team: sharedStep.team, name: req.body.name })
          .lean()
          .exec();
        if (clash) {
          throw new ConflictError(`A shared step named "${req.body.name}" already exists for this team.`);
        }
      }

      // Only a change to the steps themselves alters what a tester would do, so only that
      // bumps the version and cascades. Renaming or re-describing the shared step leaves
      // every referencing case's content identical and must not version forty of them.
      const stepsChanged = req.body.steps !== undefined
        && JSON.stringify(manualTestCaseUtils.normaliseValue(sharedStep.steps))
          !== JSON.stringify(manualTestCaseUtils.normaliseValue(req.body.steps));

      ['name', 'description'].forEach((field) => {
        if (req.body[field] !== undefined) {
          sharedStep[field] = req.body[field];
        }
      });
      if (req.body.steps !== undefined) {
        sharedStep.steps = normaliseSteps(req.body.steps);
      }
      sharedStep.updatedBy = req.user ? req.user._id : undefined;

      if (stepsChanged) {
        sharedStep.version += 1;
      }
      const saved = await sharedStep.save();

      if (!stepsChanged) {
        log(`Shared step ${sharedStepId} updated without a step change; no cascade`);
        return { saved, cascade: { versioned: 0, failed: [] } };
      }

      // The shared step is saved before the cascade so the cascade expands against the
      // content that is now current. A partial cascade is reported rather than rolled
      // back: the edit itself succeeded, and re-running it would version every case a
      // second time.
      const cascade = await sharedStepUtils.cascadeToTestCases(
        saved,
        req.user ? req.user._id : undefined,
      );
      return { saved, cascade };
    })
    .then(({ saved, cascade }) => SharedStep.findById(saved._id)
      .populate('createdBy', 'username')
      .populate('updatedBy', 'username')
      .lean()
      .exec()
      .then((populated) => res.status(200).send({
        ...populated,
        cascade: {
          testCasesVersioned: cascade.versioned,
          failures: cascade.failed,
        },
      })))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { sharedStepId } = req.params;

  return SharedStep.findById(sharedStepId)
    .then(async (sharedStep) => {
      if (!sharedStep) {
        throw new NotFoundError(`No shared step found with id ${sharedStepId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, sharedStep.team)) {
        throw new ForbiddenError('You do not have permission to manage this shared step');
      }

      // A referenced shared step is never deleted: the referencing cases would expand to
      // an unresolved placeholder on their next version, silently losing steps. The
      // author removes the inclusions first, which the usage endpoint helps them find.
      const references = await sharedStepUtils.countReferencingCases(sharedStep._id);
      if (references > 0) {
        throw new ConflictError(`Unable to delete shared step "${sharedStep.name}" as it is included by ${references} test case(s).`);
      }

      // Nothing references the shared step, so nothing references its attachments either.
      const attachmentsRemoved = await attachmentUtils
        .removeAttachmentsForOwner('sharedstep', sharedStep._id);
      log(`Deleting unreferenced shared step ${sharedStepId} along with ${attachmentsRemoved} attachment(s)`);
      return SharedStep.findByIdAndRemove(sharedStepId);
    })
    .then((sharedStep) => {
      if (!sharedStep) {
        throw new NotFoundError(`No shared step found with id ${sharedStepId}`);
      }
      return res.status(200).send({ message: 'Shared step deleted successfully!' });
    })
    .catch((err) => handleError(err, res));
};

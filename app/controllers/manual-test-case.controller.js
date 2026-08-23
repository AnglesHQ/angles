const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');

const ManualTestCase = require('../models/manual-test-case.js');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');
const { Team } = require('../models/team.js');
const manualTestCaseUtils = require('../utils/manual-test-case-utils.js');
const validationUtils = require('../utils/validation-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  ForbiddenError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('manual-test-case:controller');

// Steps arrive from the client without a guaranteed order value. Normalising here means
// the stored order always matches the array order the author sees, and the frozen version
// is written with the same ordering.
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
    team,
    component,
    title,
    description,
    preconditions,
    status,
    priority,
    tags,
    steps,
    customFields,
  } = req.body;

  return Team.findById(team).lean().exec()
    .then(async (teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${team}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, teamFound._id)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      if (component) {
        const matchComponent = teamFound.components
          .find((teamComponent) => teamComponent._id.toString() === component.toString());
        if (!matchComponent) {
          throw new NotFoundError(`No component found with id ${component} for team ${teamFound.name}`);
        }
      }

      const testCase = new ManualTestCase({
        team: teamFound._id,
        component,
        title,
        description,
        preconditions,
        status,
        priority,
        tags,
        steps: normaliseSteps(steps),
        customFields,
        version: 1,
        createdBy: req.user ? req.user._id : undefined,
        updatedBy: req.user ? req.user._id : undefined,
      });

      // The version is written first so a crash between the two writes leaves an orphan
      // version rather than a head pointing at a version that does not exist.
      await manualTestCaseUtils.saveVersion(testCase, testCase.createdBy);
      const savedCase = await testCase.save();
      log(`Created manual test case "${savedCase.title}" (v1) with id ${savedCase._id}`);
      return savedCase;
    })
    .then((savedCase) => ManualTestCase.findById(savedCase._id)
      .populate('team')
      .populate('createdBy', 'username')
      .populate('updatedBy', 'username')
      .lean()
      .exec())
    .then((savedCase) => res.status(201).send(savedCase))
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    teamId,
    status,
    tags,
    search,
    priority,
  } = req.query;
  const limit = parseInt(req.query.limit, 10) || 25;
  const skip = parseInt(req.query.skip, 10) || 0;

  return Team.findById(teamId).select('_id').lean().exec()
    .then((teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${teamId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      const query = { team: mongoose.Types.ObjectId(teamId) };
      if (status) query.status = { $in: status.split(',') };
      if (priority) query.priority = { $in: priority.split(',') };
      if (tags) query.tags = { $all: tags.split(',').map((tag) => tag.trim().toLowerCase()) };
      if (search) {
        // Interpolated into a $regex, so it must be escaped - an unescaped pattern is a
        // denial of service against the database and can widen the match.
        const escaped = validationUtils.escapeRegex(search);
        query.$or = [
          { title: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } },
        ];
      }
      log(`QUERY: ${JSON.stringify(query)}`);
      const promises = [
        ManualTestCase.find(query, null, { limit, skip })
          .populate('createdBy', 'username')
          .populate('updatedBy', 'username')
          .sort('-updatedAt')
          .lean()
          .exec(),
        ManualTestCase.countDocuments(query).exec(),
      ];
      return Promise.all(promises);
    })
    .then((results) => res.status(200).send({
      testCases: results[0],
      metrics: { totalTestCases: results[1] },
    }))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId } = req.params;
  return ManualTestCase.findById(caseId)
    .populate('team')
    .populate('createdBy', 'username')
    .populate('updatedBy', 'username')
    .lean()
    .exec()
    .then((testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team._id)) {
        throw new ForbiddenError('You do not have access to this test case');
      }
      return res.status(200).send(testCase);
    })
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId } = req.params;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return ManualTestCase.findById(caseId)
    .then(async (testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team)) {
        throw new ForbiddenError('You do not have access to this test case');
      }

      // Decided before mutating the document, against the values as they were persisted.
      const contentChanged = manualTestCaseUtils.hasContentChanged(testCase, req.body);

      const updatable = [
        'title',
        'description',
        'preconditions',
        'status',
        'priority',
        'tags',
        'customFields',
        'component',
      ];
      updatable.forEach((field) => {
        if (req.body[field] !== undefined) {
          testCase[field] = req.body[field];
        }
      });
      if (req.body.steps !== undefined) {
        testCase.steps = normaliseSteps(req.body.steps);
      }
      testCase.updatedBy = req.user ? req.user._id : undefined;

      if (contentChanged) {
        // A content change burns a version; a status-only edit (or an edit that changes
        // nothing) deliberately does not.
        testCase.version += 1;
        await manualTestCaseUtils.saveVersion(testCase, testCase.updatedBy);
        log(`Manual test case ${caseId} content changed, wrote version ${testCase.version}`);
      } else {
        log(`Manual test case ${caseId} updated without a content change, staying on version ${testCase.version}`);
      }
      return testCase.save();
    })
    .then((savedCase) => ManualTestCase.findById(savedCase._id)
      .populate('team')
      .populate('createdBy', 'username')
      .populate('updatedBy', 'username')
      .lean()
      .exec())
    .then((savedCase) => res.status(200).send(savedCase))
    .catch((err) => handleError(err, res));
};

exports.clone = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId } = req.params;
  const { title } = req.body;

  return ManualTestCase.findById(caseId).lean().exec()
    .then(async (testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team)) {
        throw new ForbiddenError('You do not have access to this test case');
      }
      // The clone starts its own version history at 1 - it is a new test case, not
      // another version of the one it was copied from. Steps are copied without their
      // _ids so the clone's steps are distinct documents.
      const clonedSteps = (testCase.steps || []).map((step) => {
        const rest = { ...step };
        delete rest._id;
        return rest;
      });
      const clonedCase = new ManualTestCase({
        team: testCase.team,
        component: testCase.component,
        title: title || `${testCase.title} (copy)`,
        description: testCase.description,
        preconditions: testCase.preconditions,
        // A clone always starts as a draft regardless of the source's status.
        status: 'DRAFT',
        priority: testCase.priority,
        tags: testCase.tags,
        steps: clonedSteps,
        customFields: testCase.customFields,
        version: 1,
        createdBy: req.user ? req.user._id : undefined,
        updatedBy: req.user ? req.user._id : undefined,
      });
      await manualTestCaseUtils.saveVersion(clonedCase, clonedCase.createdBy);
      const savedClone = await clonedCase.save();
      log(`Cloned manual test case ${caseId} into ${savedClone._id}`);
      return savedClone;
    })
    .then((savedClone) => ManualTestCase.findById(savedClone._id)
      .populate('team')
      .populate('createdBy', 'username')
      .lean()
      .exec())
    .then((savedClone) => res.status(201).send(savedClone))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId } = req.params;

  return ManualTestCase.findById(caseId)
    .then(async (testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, testCase.team)) {
        throw new ForbiddenError('You do not have permission to delete this test case');
      }
      // Deleting the case removes its version history too - the immutability rule protects
      // versions from being *rewritten*, not from the whole case being removed. Once
      // manual runs exist (phase 6) this needs a guard rejecting deletion of a case with
      // executions bound to it; there is nothing to bind yet.
      const versionsRemoved = await ManualTestCaseVersion
        .deleteMany({ testCase: testCase._id })
        .exec();
      log(`Deleting manual test case ${caseId} along with ${versionsRemoved.deletedCount} version(s).`);
      return ManualTestCase.findByIdAndRemove(caseId);
    })
    .then((testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      return res.status(200).send({ message: 'Manual test case deleted successfully!' });
    })
    .catch((err) => handleError(err, res));
};

exports.findVersions = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId } = req.params;

  return ManualTestCase.findById(caseId).lean().exec()
    .then((testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team)) {
        throw new ForbiddenError('You do not have access to this test case');
      }
      // Metadata only - the full frozen content is served per version by findVersion.
      return ManualTestCaseVersion.find({ testCase: testCase._id })
        .select('version title createdAt createdBy')
        .populate('createdBy', 'username')
        .sort('-version')
        .lean()
        .exec();
    })
    .then((versions) => res.status(200).send({ versions }))
    .catch((err) => handleError(err, res));
};

exports.findVersion = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId, version } = req.params;
  const versionNumber = parseInt(version, 10);

  return ManualTestCase.findById(caseId).lean().exec()
    .then(async (testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team)) {
        throw new ForbiddenError('You do not have access to this test case');
      }
      const frozenVersion = await manualTestCaseUtils.getVersion(testCase, versionNumber);
      if (frozenVersion === null) {
        // No version documents at all: pre-migration data, so the head is the only
        // content available. Flagged in the response so a caller can tell this apart from
        // a genuine frozen version.
        return { ...testCase, version: testCase.version, unversioned: true };
      }
      if (!frozenVersion) {
        throw new NotFoundError(`No version ${versionNumber} found for manual test case ${caseId}`);
      }
      return frozenVersion;
    })
    .then((frozenVersion) => res.status(200).send(frozenVersion))
    .catch((err) => handleError(err, res));
};

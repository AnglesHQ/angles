const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');

const ManualTestCase = require('../models/manual-test-case.js');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');
const { Team } = require('../models/team.js');
const SharedStep = require('../models/shared-step.js');
const Attachment = require('../models/attachment.js');
const manualTestCaseUtils = require('../utils/manual-test-case-utils.js');
const manualStepUtils = require('../utils/manual-step-utils.js');
const customFieldUtils = require('../utils/custom-field-utils.js');
const attachmentUtils = require('../utils/attachment-utils.js');
const historyUtils = require('../utils/history-utils.js');
const validationUtils = require('../utils/validation-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  ForbiddenError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('manual-test-case:controller');

// Required custom fields are enforced for any status other than DRAFT, so a half-written
// draft can always be saved but a case that is published carries everything it must.
//
// An absent status means the schema default (DRAFT) will apply, so it must not be treated
// as "some other status" - doing so would enforce required fields on exactly the
// create-a-draft case this rule exists to exempt.
const DEFAULT_STATUS = 'DRAFT';
const shouldEnforceRequired = (status) => (status || DEFAULT_STATUS) !== DEFAULT_STATUS;

// Steps arrive from the client without a guaranteed order value. Normalising here means
// the stored order always matches the array order the author sees, and the frozen version
// is written with the same ordering.
const normaliseSteps = (steps) => (steps || []).map((step, index) => ({
  ...step,
  order: step.order === undefined ? index + 1 : step.order,
}));

/*
Rejects an attachment reference that does not exist or belongs to another team.

Same reasoning as the shared step check below: a dangling attachment renders as a broken
image in the middle of a test a QA is trying to follow, and a cross-team reference would
expose one team's screenshots inside another team's case.
 */
const validateAttachmentReferences = async (steps, teamId) => {
  const ids = Array.from(new Set(
    (steps || []).flatMap((step) => (step.attachments || []).map((id) => id.toString())),
  ));
  if (ids.length === 0) return;
  const found = await Attachment.find({ _id: { $in: ids }, team: teamId })
    .select('_id')
    .lean()
    .exec();
  const foundIds = new Set(found.map((attachment) => attachment._id.toString()));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new NotFoundError(`No attachment found for this team with id(s): ${missing.join(', ')}`);
  }
};

/*
Rejects a shared step reference that does not exist or belongs to another team.

Caught at write time rather than at expansion: a dangling reference expands to an
unresolved placeholder, which silently costs the case its steps. A cross-team reference
would additionally leak one team's content into another's test case.
 */
const validateSharedStepReferences = async (steps, teamId) => {
  const ids = manualStepUtils.collectSharedStepIds(steps);
  if (ids.length === 0) return;
  const found = await SharedStep.find({ _id: { $in: ids }, team: teamId })
    .select('_id')
    .lean()
    .exec();
  const foundIds = new Set(found.map((sharedStep) => sharedStep._id.toString()));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new NotFoundError(`No shared step found for this team with id(s): ${missing.join(', ')}`);
  }
};

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

      await validateSharedStepReferences(steps, teamFound._id);
      await validateAttachmentReferences(steps, teamFound._id);

      // Values are validated and coerced against the team's configured fields before the
      // case is built, so nothing invalid ever reaches a frozen version.
      const definitions = await customFieldUtils.getDefinitionsForTeam(teamFound._id);
      const validatedFields = await customFieldUtils.validateCustomFields(
        definitions,
        customFields,
        shouldEnforceRequired(status),
      );

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
        customFields: validatedFields,
        version: 1,
        createdBy: req.user ? req.user._id : undefined,
        updatedBy: req.user ? req.user._id : undefined,
      });

      // The version is written first so a crash between the two writes leaves an orphan
      // version rather than a head pointing at a version that does not exist.
      //
      // Steps are expanded before freezing: a version must never hold a shared-step
      // reference, or a later edit to that shared step would rewrite what this version
      // shows.
      const snapshot = customFieldUtils.buildDefinitionSnapshot(definitions, validatedFields);
      const expandedSteps = await manualStepUtils.expandStepsFor(testCase.steps);
      await manualTestCaseUtils
        .saveVersion(testCase, testCase.createdBy, snapshot, expandedSteps);
      const savedCase = await testCase.save();
      log(`Created manual test case "${savedCase.title}" (v1) with id ${savedCase._id}`);
      // Not awaited: the case is saved, and losing an audit line must never fail the
      // request that produced it.
      historyUtils.recordChange({
        entityType: 'testcase',
        entityId: savedCase._id,
        team: savedCase.team,
        action: 'CREATE',
        version: savedCase.version,
        user: savedCase.createdBy,
        comment: req.body.comment,
      });
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
    .then(async (testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team._id)) {
        throw new ForbiddenError('You do not have access to this test case');
      }
      // The head stores shared steps as placeholders. `expand=true` resolves them into
      // the steps a tester would actually follow - what the authoring UI renders as a
      // preview, and what the next frozen version will contain.
      if (req.query.expand === 'true') {
        return res.status(200).send({
          ...testCase,
          steps: await manualStepUtils.expandStepsFor(testCase.steps),
          expanded: true,
        });
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

      if (req.body.steps !== undefined) {
        await validateSharedStepReferences(req.body.steps, testCase.team);
        await validateAttachmentReferences(req.body.steps, testCase.team);
      }

      // Captured before anything is mutated, so the diff compares against what was
      // actually persisted rather than the half-updated document.
      const before = testCase.toObject();

      const definitions = await customFieldUtils.getDefinitionsForTeam(testCase.team);

      // The status the case will end up with decides whether required fields are
      // enforced - publishing a draft has to satisfy them, editing a draft does not.
      const resultingStatus = req.body.status === undefined ? testCase.status : req.body.status;

      // Custom fields are validated before the content comparison so the comparison sees
      // coerced values. Without this a client re-sending an unchanged date as a string
      // would compare unequal to the stored Date and burn a version for no change.
      let comparableBody = req.body;
      if (req.body.customFields !== undefined) {
        const validatedFields = await customFieldUtils.validateCustomFields(
          definitions,
          req.body.customFields,
          shouldEnforceRequired(resultingStatus),
        );
        comparableBody = { ...req.body, customFields: validatedFields };
      } else if (shouldEnforceRequired(resultingStatus)
        && !shouldEnforceRequired(testCase.status)) {
        // Publishing without restating the custom fields still has to satisfy the
        // required ones, so re-validate what is already stored.
        await customFieldUtils.validateCustomFields(
          definitions,
          Object.fromEntries(testCase.customFields || new Map()),
          true,
        );
      }

      // Decided before mutating the document, against the values as they were persisted.
      const contentChanged = manualTestCaseUtils.hasContentChanged(testCase, comparableBody);

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
        if (comparableBody[field] !== undefined) {
          testCase[field] = comparableBody[field];
        }
      });
      if (req.body.steps !== undefined) {
        testCase.steps = normaliseSteps(req.body.steps);
      }
      testCase.updatedBy = req.user ? req.user._id : undefined;

      let savedCase;
      if (contentChanged) {
        // A content change burns a version; a status-only edit (or an edit that changes
        // nothing) deliberately does not.
        testCase.version += 1;
        // Recovers a case whose head fell behind its versions - see reconcileVersion.
        await manualTestCaseUtils.reconcileVersion(testCase);
        const snapshot = customFieldUtils
          .buildDefinitionSnapshot(definitions, testCase.customFields);
        const expandedSteps = await manualStepUtils.expandStepsFor(testCase.steps);

        // The head is validated before the version is written. Writing the version first
        // and then failing to save the head leaves an orphan version at the new number,
        // and because { testCase, version } is unique the next edit collides with it -
        // wedging the case permanently. Validating first turns that into a clean 422 with
        // nothing written.
        await testCase.validate();
        await manualTestCaseUtils
          .saveVersion(testCase, testCase.updatedBy, snapshot, expandedSteps);
        log(`Manual test case ${caseId} content changed, wrote version ${testCase.version}`);
        savedCase = await testCase.save();
      } else {
        log(`Manual test case ${caseId} updated without a content change, staying on version ${testCase.version}`);
        savedCase = await testCase.save();
      }

      // A status transition is audited even though it burns no version - "who published
      // this?" is exactly the sort of question history exists to answer, and the version
      // collection cannot express it.
      const statusChanged = before.status !== savedCase.status;
      const changes = historyUtils.diffDocuments(
        before,
        savedCase.toObject(),
        historyUtils.TRACKED_PATHS.testcase,
      );
      if (changes.length > 0) {
        historyUtils.recordChange({
          entityType: 'testcase',
          entityId: savedCase._id,
          team: savedCase.team,
          action: statusChanged && !contentChanged ? 'STATUS_CHANGE' : 'UPDATE',
          version: savedCase.version,
          changes,
          user: savedCase.updatedBy,
          comment: req.body.comment,
        });
      }
      return savedCase;
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
      // The clone carries the source's custom field values, so its first version needs
      // the same definition snapshot to render them.
      const definitions = await customFieldUtils.getDefinitionsForTeam(testCase.team);
      const snapshot = customFieldUtils
        .buildDefinitionSnapshot(definitions, testCase.customFields);
      const expandedSteps = await manualStepUtils.expandStepsFor(clonedCase.steps);
      await manualTestCaseUtils
        .saveVersion(clonedCase, clonedCase.createdBy, snapshot, expandedSteps);
      const savedClone = await clonedCase.save();
      log(`Cloned manual test case ${caseId} into ${savedClone._id}`);
      historyUtils.recordChange({
        entityType: 'testcase',
        entityId: savedClone._id,
        team: savedClone.team,
        action: 'CLONE',
        version: savedClone.version,
        user: savedClone.createdBy,
        comment: req.body.comment || `Cloned from test case ${caseId}`,
      });
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
      // Versions are removed first, so the reference check that protects an attachment
      // referenced by a frozen version no longer applies - the thing referencing it has
      // gone. Files and documents are collected together.
      const attachmentsRemoved = await attachmentUtils
        .removeAttachmentsForOwner('testcase', testCase._id);
      log(`Deleting manual test case ${caseId} along with ${versionsRemoved.deletedCount} version(s) and ${attachmentsRemoved} attachment(s).`);
      // Recorded before the removal, while the team is still readable from the document.
      // The entry outlives the case on purpose: "what happened to that test case?" is
      // only answerable if the deletion itself is logged.
      historyUtils.recordChange({
        entityType: 'testcase',
        entityId: testCase._id,
        team: testCase.team,
        action: 'DELETE',
        version: testCase.version,
        user: req.user ? req.user._id : undefined,
        comment: req.body.comment || `Deleted "${testCase.title}"`,
      });
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

exports.findHistory = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { caseId } = req.params;
  const limit = parseInt(req.query.limit, 10) || 20;
  const skip = parseInt(req.query.skip, 10) || 0;

  return ManualTestCase.findById(caseId).select('_id team').lean().exec()
    .then((testCase) => {
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, testCase.team)) {
        throw new ForbiddenError('You do not have access to this test case');
      }
      return historyUtils.findHistory(testCase._id, limit, skip);
    })
    .then(({ entries, count }) => res.status(200).send({
      history: entries,
      metrics: { totalEntries: count },
    }))
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

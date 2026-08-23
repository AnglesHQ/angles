const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');

const ManualTestRun = require('../models/manual-test-run.js');
const ManualTestCase = require('../models/manual-test-case.js');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');
const { Team } = require('../models/team.js');
const Environment = require('../models/environment.js');
const Phase = require('../models/phase.js');
const manualTestRunUtils = require('../utils/manual-test-run-utils.js');
const buildMetricsUtils = require('../utils/build-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidRequestError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('manual-test-run:controller');

const RUN_POPULATE = [
  { path: 'team' },
  { path: 'environment' },
  { path: 'phase' },
  { path: 'assignedTo', select: 'username' },
  { path: 'createdBy', select: 'username' },
  { path: 'testCases.executedBy', select: 'username' },
];

const populateRun = (runId) => {
  const query = ManualTestRun.findById(runId);
  RUN_POPULATE.forEach((populate) => query.populate(populate));
  return query.lean().exec();
};

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    name,
    description,
    team,
    component,
    environment,
    phase,
    assignedTo,
    platforms,
    testCaseIds,
  } = req.body;

  return Promise.all([
    Team.findById(team).lean().exec(),
    Environment.findOne({ name: environment }).lean().exec(),
    phase ? Phase.findOne({ name: phase }).lean().exec() : Promise.resolve(null),
  ])
    .then(async ([teamFound, environmentFound, phaseFound]) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${team}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, teamFound._id)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      if (!environmentFound) {
        throw new NotFoundError(`No environment found with name ${environment}`);
      }
      if (phase && !phaseFound) {
        throw new NotFoundError(`No phase found with name ${phase}`);
      }

      let matchComponent;
      if (component) {
        matchComponent = teamFound.components
          .find((teamComponent) => teamComponent._id.toString() === component.toString());
        if (!matchComponent) {
          throw new NotFoundError(`No component found with id ${component} for team ${teamFound.name}`);
        }
      } else {
        // The backing build requires a component, so fall back to the team's first one
        // rather than refusing a run the caller did not think to scope.
        [matchComponent] = teamFound.components;
        if (!matchComponent) {
          throw new InvalidRequestError(`Team ${teamFound.name} has no components to run against.`);
        }
      }

      // Bound to each case's current frozen version. Everything downstream reads the
      // version, never the mutable head.
      const boundCases = await manualTestRunUtils
        .bindTestCases(testCaseIds || [], teamFound._id, matchComponent._id);

      const start = new Date();
      // The build is created up front so executions have somewhere to land, and is tagged
      // manual so every existing dashboard and metrics query counts it correctly.
      const build = new Build({
        name: name.toLowerCase(),
        team: teamFound._id,
        environment: environmentFound._id,
        component: matchComponent._id,
        phase: phaseFound ? phaseFound._id : undefined,
        suites: [],
        start,
        executionType: 'manual',
        result: new Map(buildMetricsUtils.defaultResultMap),
        status: buildMetricsUtils.executionStates[0],
      });
      const savedBuild = await build.save();

      const run = new ManualTestRun({
        name,
        description,
        team: teamFound._id,
        component: matchComponent._id,
        environment: environmentFound._id,
        phase: phaseFound ? phaseFound._id : undefined,
        build: savedBuild._id,
        status: 'PLANNED',
        assignedTo,
        platforms,
        testCases: boundCases,
        start,
        createdBy: req.user ? req.user._id : undefined,
      });

      try {
        const savedRun = await run.save();
        log(`Created manual test run "${name}" with ${boundCases.length} case(s), build ${savedBuild._id}`);
        return savedRun;
      } catch (error) {
        // Don't leave a manual build behind with no run pointing at it - it would show on
        // the dashboard as an empty run nobody can complete.
        await Build.deleteOne({ _id: savedBuild._id }).exec();
        throw error;
      }
    })
    .then((savedRun) => populateRun(savedRun._id))
    .then((savedRun) => res.status(201).send(savedRun))
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, status, assignedTo } = req.query;
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
      if (assignedTo) query.assignedTo = mongoose.Types.ObjectId(assignedTo);

      return Promise.all([
        ManualTestRun.find(query, null, { limit, skip })
          .populate('environment')
          .populate('phase')
          .populate('assignedTo', 'username')
          .populate('createdBy', 'username')
          .sort('-createdAt')
          .lean()
          .exec(),
        ManualTestRun.countDocuments(query).exec(),
      ]);
    })
    .then(([runs, count]) => res.status(200).send({
      testRuns: runs,
      metrics: { totalTestRuns: count },
    }))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { runId } = req.params;

  return populateRun(runId)
    .then(async (run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, run.team._id)) {
        throw new ForbiddenError('You do not have access to this test run');
      }
      // The tester needs the steps, and they must come from the bound version rather than
      // the case - that is the whole point of the binding.
      if (req.query.expand === 'true') {
        const versionIds = run.testCases.map((runCase) => runCase.testCaseVersion);
        const versions = await ManualTestCaseVersion
          .find({ _id: { $in: versionIds } })
          .lean()
          .exec();
        const byId = new Map(versions.map((version) => [version._id.toString(), version]));
        return {
          ...run,
          testCases: run.testCases.map((runCase) => ({
            ...runCase,
            version: byId.get(runCase.testCaseVersion.toString()),
          })),
          expanded: true,
        };
      }
      return run;
    })
    .then((run) => res.status(200).send(run))
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { runId } = req.params;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return ManualTestRun.findById(runId)
    .then(async (run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, run.team)) {
        throw new ForbiddenError('You do not have access to this test run');
      }

      ['name', 'description', 'assignedTo', 'platforms'].forEach((field) => {
        if (req.body[field] !== undefined) {
          run[field] = req.body[field];
        }
      });

      // Cases can be added to a run in flight; each is bound to its current version at
      // the moment it is added, not the moment the run was created.
      if (req.body.testCaseIds !== undefined) {
        const existingIds = new Set(run.testCases.map((runCase) => runCase.testCase.toString()));
        const newIds = req.body.testCaseIds
          .map((id) => id.toString())
          .filter((id) => !existingIds.has(id));
        if (newIds.length > 0) {
          const bound = await manualTestRunUtils
            .bindTestCases(newIds, run.team, run.component);
          bound.forEach((runCase) => run.testCases.push(runCase));
        }
      }

      run.status = manualTestRunUtils.deriveStatus(run);
      return run.save();
    })
    .then((savedRun) => populateRun(savedRun._id))
    .then((savedRun) => res.status(200).send(savedRun))
    .catch((err) => handleError(err, res));
};

exports.recordResult = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { runId, caseId } = req.params;
  const { status, stepResults, notes } = req.body;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return ManualTestRun.findById(runId)
    .then(async (run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, run.team)) {
        throw new ForbiddenError('You do not have access to this test run');
      }
      if (run.status === 'CANCELLED') {
        throw new ConflictError('Cannot record a result against a cancelled test run.');
      }

      const runCase = run.testCases
        .find((entry) => entry.testCase.toString() === caseId.toString());
      if (!runCase) {
        throw new NotFoundError(`Test case ${caseId} is not part of this test run`);
      }

      // Read from the bound version, never the head - the tester executed this content.
      const version = await ManualTestCaseVersion
        .findById(runCase.testCaseVersion)
        .lean()
        .exec();
      if (!version) {
        throw new NotFoundError(`The frozen version bound to test case ${caseId} no longer exists.`);
      }

      if (!runCase.start) {
        runCase.start = new Date();
      }
      if (stepResults !== undefined) {
        runCase.stepResults = stepResults;
      }
      if (notes !== undefined) {
        runCase.notes = notes;
      }
      runCase.status = status;
      runCase.executedBy = req.user ? req.user._id : undefined;
      if (status !== 'IN_PROGRESS' && status !== 'NOT_RUN') {
        runCase.end = new Date();
      }

      // Written through the same path automated results take, so the build's result map
      // and status are computed identically for both.
      const execution = await manualTestRunUtils.recordExecution({
        run,
        runCase,
        version,
        status,
        user: req.user ? req.user._id : undefined,
      });
      runCase.execution = execution._id;

      run.status = manualTestRunUtils.deriveStatus(run);
      if (run.status === 'COMPLETED' && !run.end) {
        run.end = new Date();
      }
      return run.save();
    })
    .then((savedRun) => populateRun(savedRun._id))
    .then((savedRun) => res.status(200).send(savedRun))
    .catch((err) => handleError(err, res));
};

/*
Moves a not-yet-run case onto the latest version of its test case.

Refused once a result has been recorded: re-pointing an execution at content it was never
run against is exactly the silent history rewrite the version binding exists to prevent.
 */
exports.rebind = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { runId, caseId } = req.params;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return ManualTestRun.findById(runId)
    .then(async (run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, run.team)) {
        throw new ForbiddenError('You do not have access to this test run');
      }
      const runCase = run.testCases
        .find((entry) => entry.testCase.toString() === caseId.toString());
      if (!runCase) {
        throw new NotFoundError(`Test case ${caseId} is not part of this test run`);
      }
      if (runCase.status !== 'NOT_RUN' || runCase.execution) {
        throw new ConflictError('Cannot rebind a test case that already has a recorded result. Add the test case to a new run instead.');
      }

      const testCase = await ManualTestCase.findById(caseId).lean().exec();
      if (!testCase) {
        throw new NotFoundError(`No manual test case found with id ${caseId}`);
      }
      if (testCase.version === runCase.versionNumber) {
        throw new ConflictError(`Test case is already bound to its latest version (v${runCase.versionNumber}).`);
      }

      const [bound] = await manualTestRunUtils
        .bindTestCases([caseId], run.team, run.component);
      runCase.testCaseVersion = bound.testCaseVersion;
      runCase.versionNumber = bound.versionNumber;
      runCase.snapshotTitle = bound.snapshotTitle;
      // Results recorded against the old version's step ids would be meaningless here.
      runCase.stepResults = [];
      log(`Rebound case ${caseId} in run ${runId} to v${bound.versionNumber}`);
      return run.save();
    })
    .then((savedRun) => populateRun(savedRun._id))
    .then((savedRun) => res.status(200).send(savedRun))
    .catch((err) => handleError(err, res));
};

exports.updateStatus = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { runId } = req.params;
  const { status } = req.body;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return ManualTestRun.findById(runId)
    .then(async (run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, run.team)) {
        throw new ForbiddenError('You do not have access to this test run');
      }
      run.status = status;
      if (status === 'COMPLETED' || status === 'CANCELLED') {
        run.end = run.end || new Date();
      }
      if (status === 'IN_PROGRESS' && !run.start) {
        run.start = new Date();
      }
      log(`Manual test run ${runId} moved to ${status}`);
      return run.save();
    })
    .then((savedRun) => populateRun(savedRun._id))
    .then((savedRun) => res.status(200).send(savedRun))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { runId } = req.params;

  return ManualTestRun.findById(runId)
    .then(async (run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, run.team)) {
        throw new ForbiddenError('You do not have permission to delete this test run');
      }
      // The backing build and its executions exist only to represent this run on the
      // dashboard, so they go with it - leaving them would show results for a run that no
      // longer exists.
      if (run.build) {
        await TestExecution.deleteMany({ build: run.build }).exec();
        await Build.deleteOne({ _id: run.build }).exec();
      }
      log(`Deleting manual test run ${runId} along with its build ${run.build}`);
      return ManualTestRun.findByIdAndRemove(runId);
    })
    .then((run) => {
      if (!run) {
        throw new NotFoundError(`No manual test run found with id ${runId}`);
      }
      return res.status(200).send({ message: 'Manual test run deleted successfully!' });
    })
    .catch((err) => handleError(err, res));
};

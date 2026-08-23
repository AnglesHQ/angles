const debug = require('debug');
const ManualTestCase = require('../models/manual-test-case.js');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');
const TestExecution = require('../models/execution.js');
const { EXECUTION_STATUS_BY_CASE_STATUS } = require('../models/manual-test-run.js');
const buildMetricsUtils = require('./build-utils.js');
const { NotFoundError, InvalidRequestError } = require('../exceptions/errors.js');

const log = debug('manual-test-run:utils');
const manualTestRunUtils = {};

manualTestRunUtils.EXECUTION_STATUS_BY_CASE_STATUS = EXECUTION_STATUS_BY_CASE_STATUS;

/*
Resolves a list of test case ids to run entries bound to each case's *current* version.

The binding is the point of the whole exercise: the run points at an immutable version
document, so editing the case afterwards cannot change what the tester is asked to do, and
the execution written at the end records exactly which content was run.

Rejects a DEPRECATED case - deprecating is how a team retires a test, and letting one into
a new run silently would defeat the status. Also rejects a case from a different component
than the run's, because the backing build carries a single component and a mismatch would
make the component metrics wrong.
 */
manualTestRunUtils.bindTestCases = async (testCaseIds, team, component) => {
  const uniqueIds = Array.from(new Set(testCaseIds.map((id) => id.toString())));
  const testCases = await ManualTestCase.find({ _id: { $in: uniqueIds }, team }).lean().exec();

  const byId = new Map(testCases.map((testCase) => [testCase._id.toString(), testCase]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new NotFoundError(`No manual test case found for this team with id(s): ${missing.join(', ')}`);
  }

  const deprecated = testCases.filter((testCase) => testCase.status === 'DEPRECATED');
  if (deprecated.length > 0) {
    const titles = deprecated.map((testCase) => `"${testCase.title}"`).join(', ');
    throw new InvalidRequestError(`Cannot add deprecated test case(s) to a run: ${titles}. Reactivate them first.`);
  }

  if (component) {
    const mismatched = testCases.filter((testCase) => testCase.component
      && testCase.component.toString() !== component.toString());
    if (mismatched.length > 0) {
      const titles = mismatched.map((testCase) => `"${testCase.title}"`).join(', ');
      throw new InvalidRequestError(`Test case(s) ${titles} belong to a different component than this run.`);
    }
  }

  // One query for every version rather than one per case.
  const versions = await ManualTestCaseVersion.find({
    $or: testCases.map((testCase) => ({ testCase: testCase._id, version: testCase.version })),
  }).lean().exec();
  const versionByCase = new Map(versions.map((version) => [version.testCase.toString(), version]));

  return uniqueIds.map((id) => {
    const testCase = byId.get(id);
    const version = versionByCase.get(id);
    if (!version) {
      // Only reachable for a case written before version tracking existed. Binding to
      // nothing would leave the run unable to say what was executed, so it is refused
      // rather than silently falling back to the mutable head.
      throw new NotFoundError(`Manual test case "${testCase.title}" has no frozen version ${testCase.version} to bind to.`);
    }
    return {
      testCase: testCase._id,
      testCaseVersion: version._id,
      versionNumber: version.version,
      snapshotTitle: version.title,
      status: 'NOT_RUN',
      stepResults: [],
    };
  });
};

/*
Builds the TestExecution actions array from a frozen version and the recorded step results.

The automated model already has the right shape: an execution holds actions, each holding
steps with name/expected/actual/status. A manual case becomes a single action whose steps
are the case's steps, so nothing downstream has to know the difference.
 */
manualTestRunUtils.buildActions = (version, stepResults, recordedAt) => {
  const resultByStepId = new Map(
    (stepResults || [])
      .filter((result) => result.stepId)
      .map((result) => [result.stepId.toString(), result]),
  );

  const steps = (version.steps || []).map((step, index) => {
    // Bound by the frozen step's _id so a later reorder cannot pull a result onto the
    // wrong step; falls back to position for a client that sends results in order.
    const result = resultByStepId.get(step._id.toString()) || (stepResults || [])[index] || {};
    return {
      name: step.action,
      expected: step.expected,
      actual: result.actual,
      info: result.notes,
      status: manualTestRunUtils.stepStatusFor(result.status),
      timestamp: result.timestamp || recordedAt,
      attachments: result.attachments,
    };
  });

  return [{
    name: version.title,
    steps,
    start: recordedAt,
    end: recordedAt,
  }];
};

/*
Maps a step result state to the Step status enum, which is a different (larger) set than
the execution states - it carries INFO and DEBUG for automated logging.
 */
manualTestRunUtils.stepStatusFor = (status) => {
  switch (status) {
    case 'PASS': return 'PASS';
    case 'FAIL': return 'FAIL';
    // A blocked or skipped step was not verified. INFO records it without contributing a
    // failure, matching how the automated model treats non-assertive steps.
    case 'BLOCKED':
    case 'SKIPPED':
    case 'NOT_RUN':
    default: return 'INFO';
  }
};

/*
Creates or updates the TestExecution for one case of a run, then folds it into the backing
build.

Deliberately routed through buildMetricsUtils.addExecutionToBuild rather than recomputing
the build here: that function owns the suite grouping, the result map and the
optimistic-concurrency retry loop, and manual results must land in the build exactly the
way automated ones do or the two would drift.
 */
manualTestRunUtils.recordExecution = async ({
  run,
  runCase,
  version,
  status,
  user,
}) => {
  const recordedAt = new Date();
  const executionStatus = EXECUTION_STATUS_BY_CASE_STATUS[status] || 'SKIPPED';
  const actions = manualTestRunUtils.buildActions(version, runCase.stepResults, recordedAt);

  const payload = {
    title: version.title,
    // Groups every case of a run under one suite named for the run, mirroring how an
    // automated framework groups a spec file's tests.
    suite: run.name,
    build: run.build,
    start: runCase.start || recordedAt,
    end: recordedAt,
    actions,
    platforms: run.platforms,
    status: executionStatus,
    executionType: 'manual',
    manualTestCase: runCase.testCase,
    manualTestCaseVersion: runCase.testCaseVersion,
    versionNumber: runCase.versionNumber,
    executedBy: user,
  };

  let execution;
  if (runCase.execution) {
    // Re-recording a result updates the existing execution rather than adding a second
    // one, so the build's totals stay equal to the number of cases in the run.
    execution = await TestExecution
      .findByIdAndUpdate(runCase.execution, payload, { new: true })
      .exec();
  }
  if (!execution) {
    execution = await new TestExecution(payload).save();
  }

  log(`Recorded manual execution ${execution._id} (${executionStatus}) for run ${run._id}`);
  await buildMetricsUtils.addExecutionToBuild(run.build, execution);
  return execution;
};

/*
Derives a run's overall status from its cases, so the run list does not lie about progress.

A run is only COMPLETED once every case has a terminal result; any case in flight makes it
IN_PROGRESS. CANCELLED is set explicitly and never derived.
 */
manualTestRunUtils.deriveStatus = (run) => {
  if (run.status === 'CANCELLED') return 'CANCELLED';
  const cases = run.testCases || [];
  if (cases.length === 0) return run.status;
  const outstanding = cases.filter((runCase) => runCase.status === 'NOT_RUN'
    || runCase.status === 'IN_PROGRESS');
  if (outstanding.length === 0) return 'COMPLETED';
  if (outstanding.length === cases.length) return run.status === 'PLANNED' ? 'PLANNED' : 'IN_PROGRESS';
  return 'IN_PROGRESS';
};

module.exports = manualTestRunUtils;

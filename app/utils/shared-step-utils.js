const debug = require('debug');
const ManualTestCase = require('../models/manual-test-case.js');
const SharedStep = require('../models/shared-step.js');
const manualStepUtils = require('./manual-step-utils.js');
const manualTestCaseUtils = require('./manual-test-case-utils.js');
const customFieldUtils = require('./custom-field-utils.js');
const historyUtils = require('./history-utils.js');

const log = debug('shared-step:utils');
const sharedStepUtils = {};

/*
Finds every test case whose head includes the given shared step.
 */
sharedStepUtils.findReferencingCases = (sharedStepId, projection = null) => ManualTestCase
  .find({ 'steps.sharedStep': sharedStepId }, projection)
  .exec();

sharedStepUtils.countReferencingCases = (sharedStepId) => ManualTestCase
  .countDocuments({ 'steps.sharedStep': sharedStepId })
  .exec();

/*
Cascades an edited shared step into every test case that includes it.

Each referencing case gets its version incremented and a fresh frozen version written,
re-expanded against the new shared step content. The case's *head* is untouched apart
from the version counter - it still holds the placeholder, so it keeps tracking the
shared step - but every version from here on records the new expansion.

This is what keeps history exact. A version stores expanded steps, so versions written
before this edit still show the old content; without the cascade the live case would show
new content while its latest version showed old, and the two would disagree about what
"current" means.

Failures are collected rather than thrown: a shared step edit that has already been saved
must not be reported as failed because one of forty cases could not be versioned. The
caller logs and reports the count.
 */
sharedStepUtils.cascadeToTestCases = async (sharedStep, userId) => {
  const cases = await sharedStepUtils.findReferencingCases(sharedStep._id);
  if (cases.length === 0) {
    return { versioned: 0, failed: [] };
  }

  const sharedStepsById = new Map([[sharedStep._id.toString(), sharedStep]]);
  const failed = [];
  let versioned = 0;

  // Sequential on purpose: each case is an independent read-modify-write against its own
  // document, and firing forty of them at once would contend for the same connection pool
  // for no benefit on what is already a rare admin-triggered operation.
  /* eslint-disable no-await-in-loop, no-restricted-syntax */
  for (const testCase of cases) {
    try {
      // Other shared steps this case references also need resolving, so the expansion
      // reflects the whole case rather than only the edited step.
      const otherIds = manualStepUtils.collectSharedStepIds(testCase.steps)
        .filter((id) => id !== sharedStep._id.toString());
      const resolved = new Map(sharedStepsById);
      if (otherIds.length > 0) {
        const others = await SharedStep.find({ _id: { $in: otherIds } }).lean().exec();
        others.forEach((other) => resolved.set(other._id.toString(), other));
      }

      const expandedSteps = manualStepUtils.expandSteps(testCase.steps, resolved);
      const definitions = await customFieldUtils.getDefinitionsForTeam(testCase.team);
      const snapshot = customFieldUtils
        .buildDefinitionSnapshot(definitions, testCase.customFields);

      testCase.version += 1;
      // Recovers a case whose head fell behind its versions - see reconcileVersion.
      await manualTestCaseUtils.reconcileVersion(testCase);
      testCase.updatedBy = userId;
      // Validated before the version is written, so a case the cascade cannot save does
      // not leave an orphan version behind that wedges every later edit.
      await testCase.validate();
      // The version document carries the expanded steps; the head keeps its placeholders.
      await manualTestCaseUtils.saveVersion(
        testCase,
        userId,
        snapshot,
        expandedSteps,
      );
      await testCase.save();

      // Records why a case changed when nobody edited it directly. Without this the
      // history shows an unexplained version bump against every case that happens to
      // include the shared step.
      historyUtils.recordChange({
        entityType: 'testcase',
        entityId: testCase._id,
        team: testCase.team,
        action: 'SHARED_STEP_UPDATE',
        version: testCase.version,
        user: userId,
        causedBy: sharedStep._id,
        comment: `Re-versioned because shared step "${sharedStep.name}" was updated to v${sharedStep.version}`,
      });
      versioned += 1;
    } catch (error) {
      log(`Failed to cascade shared step ${sharedStep._id} into test case ${testCase._id}: ${error.message}`);
      failed.push({ testCase: testCase._id, error: error.message });
    }
  }
  /* eslint-enable no-await-in-loop, no-restricted-syntax */

  log(`Cascaded shared step ${sharedStep._id} into ${versioned} test case(s), ${failed.length} failure(s)`);
  return { versioned, failed };
};

module.exports = sharedStepUtils;

const Build = require('../models/build.js');
const TestExecution = require('../models/execution.js');

const buildUtils = {};

buildUtils.executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];

buildUtils.addExecutionToBuild = (build, execution) => {
  let buildSuite = build.suites.find((suite) => suite.name === execution.suite);
  if (buildSuite) {
    buildSuite.executions.push(execution);
    buildSuite.result.set(execution.status, buildSuite.result.get(execution.status) + 1);
    return build.save();
  }
  buildSuite = {
    name: execution.suite,
    result: new Map([['PASS', 0], ['FAIL', 0], ['ERROR', 0], ['SKIPPED', 0]]),
    executions: [execution],
  };
  buildSuite.result.set(execution.status, buildSuite.result.get(execution.status) + 1);
  return Build.updateOne(
    { _id: build.id },
    { $push: { suites: buildSuite } },
  ).then(() => Build.findById(build.id));
};

buildUtils.setStatesForActions = (testExecution) => {
  /* eslint no-param-reassign: ["error", { "props": false }] */
  for (let i = 0, len = testExecution.actions.length; i < len; i += 1) {
    const currentAction = testExecution.actions[i];
    const defaultState = buildUtils.executionStates[0];
    currentAction.status = defaultState;
    if (currentAction.steps) {
      // go through all the steps and set the state of the action.
      for (let j = 0, stepLen = currentAction.steps.length; j < stepLen; j += 1) {
        const currentStep = currentAction.steps[j];
        if (buildUtils.executionStates.indexOf(currentStep.status)
          > buildUtils.executionStates.indexOf(currentAction.status)) {
          // change the state as it's a 'higher' state.
          currentAction.status = currentStep.status;
        }
      }
    }
    // update the test status based on the action states
    if (buildUtils.executionStates.indexOf(currentAction.status)
      > buildUtils.executionStates.indexOf(testExecution.status)) {
      // change the state as it's a 'higher' state.
      testExecution.status = currentAction.status;
    }
  }
};


buildUtils.createExecution = (req, build) => {
  const {
    title, suite, start, end, platforms, tags, meta, actions,
  } = req.body;

  const testExecution = new TestExecution({
    title,
    suite,
    build,
    start,
    end,
    platforms,
    tags,
    meta,
    actions,
    status: buildUtils.executionStates[0],
  });
  if (actions) {
    buildUtils.setStatesForActions(testExecution);
  }
  return testExecution;
};

module.exports = buildUtils;

const Build = require('../models/build.js');
const TestExecution = require('../models/execution.js');

const buildMetricsUtils = {};

buildMetricsUtils.executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];
buildMetricsUtils.defaultResultMap = new Map([['PASS', 0], ['FAIL', 0], ['ERROR', 0], ['SKIPPED', 0]]);
const [defaultStatus] = buildMetricsUtils.executionStates;

buildMetricsUtils.addExecutionToBuild = (build, execution) => {
  let buildSuite = build.suites.find((suite) => suite.name === execution.suite);
  if (buildSuite) {
    // if build suite exists update it.
    buildSuite.executions.push(execution);
    buildMetricsUtils.calculateBuildMetrics(build);
  } else {
    // if it doesn't exists create it.
    buildSuite = {
      name: execution.suite,
      executions: [execution],
    };
    build.suites.push(buildSuite);
    buildMetricsUtils.calculateBuildMetrics(build);
  }
  return Build.updateOne(
    { _id: build.id },
    { $set: build },
  ).then(() => Build.findById(build.id));
};

buildMetricsUtils.calculateBuildMetrics = (build) => {
  build.result = new Map(buildMetricsUtils.defaultResultMap);
  build.start = undefined;
  build.end = undefined;
  build.status = defaultStatus;
  for (let i = 0, len = build.suites.length; i < len; i += 1) {
    let suite = build.suites[i];
    suite = buildMetricsUtils.calculateSuiteMetrics(suite);
    suite.result.forEach((value, key) => {
      build.result.set(key, build.result.get(key) + value);
    });
    if (build.end === undefined || build.end < suite.end) {
      build.end = suite.end;
    }
    if (build.start === undefined || build.start > suite.start) {
      build.start = suite.start;
    }
    build.status = buildMetricsUtils.determineNewState(build.status, suite.status);
  }
  return build;
};

buildMetricsUtils.calculateSuiteMetrics = (suite) => {
  suite.result = new Map(buildMetricsUtils.defaultResultMap);
  suite.start = undefined;
  suite.end = undefined;
  suite.status = defaultStatus;
  for (let i = 0, len = suite.executions.length; i < len; i += 1) {
    const execution = suite.executions[i];
    suite.result.set(execution.status, suite.result.get(execution.status) + 1);
    if (suite.end === undefined || suite.end < execution.end) {
      suite.end = execution.end;
    }
    if (suite.start === undefined || suite.start > execution.start) {
      suite.start = execution.start;
    }
    suite.status = buildMetricsUtils.determineNewState(suite.status, execution.status);
  }
  return suite;
};

buildMetricsUtils.calculateExecutionMetrics = (testExecution) => {
  /* eslint no-param-reassign: ["error", { "props": false }] */
  testExecution.start = undefined;
  testExecution.end = undefined;
  for (let i = 0, len = testExecution.actions.length; i < len; i += 1) {
    const currentAction = testExecution.actions[i];
    const defaultState = buildMetricsUtils.executionStates[0];
    currentAction.status = defaultState;
    if (currentAction.steps) {
      // set timestamp of action based on first and last step.
      currentAction.start = currentAction.steps[0].timestamp;
      currentAction.end = currentAction.steps[currentAction.steps.length - 1].timestamp;
      for (let j = 0, stepLen = currentAction.steps.length; j < stepLen; j += 1) {
        const currentStep = currentAction.steps[j];
        if (buildMetricsUtils.executionStates.indexOf(currentStep.status)
          > buildMetricsUtils.executionStates.indexOf(currentAction.status)) {
          // change the state as it's a 'higher' state.
          currentAction.status = currentStep.status;
        }
      }
      if (testExecution.start === undefined || testExecution.start > currentAction.start) {
        testExecution.start = currentAction.start;
      }
      if (testExecution.end === undefined || testExecution.end < currentAction.end) {
        testExecution.end = currentAction.end;
      }
    }
    // update the test status based on the action states
    if (buildMetricsUtils.executionStates.indexOf(currentAction.status)
      > buildMetricsUtils.executionStates.indexOf(testExecution.status)) {
      // change the state as it's a 'higher' state.
      testExecution.status = currentAction.status;
    }
  }
};

buildMetricsUtils.determineNewState = (existingState, newState) => {
  if (buildMetricsUtils.executionStates.indexOf(existingState)
    > buildMetricsUtils.executionStates.indexOf(newState)) {
    return existingState;
  }
  return newState;
};

buildMetricsUtils.createExecution = (req, build) => {
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
    status: buildMetricsUtils.executionStates[0],
  });
  if (actions) {
    buildMetricsUtils.calculateExecutionMetrics(testExecution);
  }
  return testExecution;
};

module.exports = buildMetricsUtils;

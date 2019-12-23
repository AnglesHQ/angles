const mongoose = require('mongoose');
const Build = require('../models/build.js');
const TestExecution = require('../models/execution.js');

const buildUtils = {};

buildUtils.executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];

buildUtils.addExecutionToBuild = (build, execution) => {
  let buildSuite = build.suites.find((suite) => suite.name === execution.suite);
  if (buildSuite) {
    // if build suite exists update it.
    buildSuite.executions.push(execution);
    buildUtils.calculateSuiteMetrics(buildSuite);
    return Build.findOneAndUpdate(
      { _id: build.id },
      { $set: { 'suites.$[elem]': buildSuite } },
      {
        arrayFilters: [
          {
            'elem._id': new mongoose.Types.ObjectId(buildSuite.id),
          },
        ],
        new: true,
      },
    ).exec();
  }
  // if the build suite doesn't exist create it.
  buildSuite = {
    name: execution.suite,
    executions: [execution],
  };
  buildUtils.calculateSuiteMetrics(buildSuite);
  return Build.updateOne(
    { _id: build.id },
    { $push: { suites: buildSuite } },
  ).then(() => Build.findById(build.id));
};

buildUtils.calculateSuiteMetrics = (suite) => {
  // (re)set results map
  suite.result = new Map([['PASS', 0], ['FAIL', 0], ['ERROR', 0], ['SKIPPED', 0]]);
  suite.start = undefined;
  suite.end = undefined;
  for (let i = 0, len = suite.executions.length; i < len; i += 1) {
    const execution = suite.executions[i];
    suite.result.set(execution.status, suite.result.get(execution.status) + 1);
    if (suite.end === undefined || suite.end < execution.end) {
      suite.end = execution.end;
    }
    if (suite.start === undefined || suite.start < execution.start) {
      suite.start = execution.start;
    }
  }
};

buildUtils.calculateExecutionMetrics = (testExecution) => {
  /* eslint no-param-reassign: ["error", { "props": false }] */
  testExecution.start = undefined;
  testExecution.end = undefined;
  for (let i = 0, len = testExecution.actions.length; i < len; i += 1) {
    const currentAction = testExecution.actions[i];
    const defaultState = buildUtils.executionStates[0];
    currentAction.status = defaultState;
    if (currentAction.steps) {
      // set timestamp of action based on first and last step.
      currentAction.start = currentAction.steps[0].timestamp;
      currentAction.end = currentAction.steps[currentAction.steps.length - 1].timestamp;
      for (let j = 0, stepLen = currentAction.steps.length; j < stepLen; j += 1) {
        const currentStep = currentAction.steps[j];
        if (buildUtils.executionStates.indexOf(currentStep.status)
          > buildUtils.executionStates.indexOf(currentAction.status)) {
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
    buildUtils.calculateExecutionMetrics(testExecution);
  }
  return testExecution;
};

module.exports = buildUtils;

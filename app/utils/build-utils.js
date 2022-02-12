const debug = require('debug');
const Build = require('../models/build.js');
const TestExecution = require('../models/execution.js');

const log = debug('metrics');
const buildUtils = {};

buildUtils.executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];
buildUtils.defaultResultMap = new Map([['PASS', 0], ['FAIL', 0], ['ERROR', 0], ['SKIPPED', 0]]);
const [defaultStatus] = buildUtils.executionStates;

buildUtils.addExecutionToBuild = (build, execution) => {
  const buildSuite = build.suites
    .find((suite) => suite.name.toLowerCase() === execution.suite.toLowerCase());
  let query;
  let update;
  if (buildSuite === undefined) {
    log(`Creating suite ${execution.suite} for build ${build._id} and adding test ${execution._id}`);
    const newSuite = {
      name: execution.suite,
      executions: [],
    };
    newSuite.executions.push(execution);
    query = { _id: build.id };
    update = { $push: { suites: newSuite } };
  } else {
    log(`Adding test ${execution._id} to suite ${execution.suite} for build ${build._id}`);
    // if build suite exists add the test to it.
    query = { _id: build.id, 'suites.name': execution.suite };
    update = { $push: { 'suites.$.executions': execution } };
  }
  return Build.findOneAndUpdate(query, update, { new: true })
    .populate('suites.executions')
    .then((updatedBuild) => {
      // once updated we update the build metrics
      const buildWithMetrics = buildUtils.calculateBuildMetrics(updatedBuild);
      log(`Update build: ${JSON.stringify(buildWithMetrics)}`);
      return buildWithMetrics.save();
    })
    .then((savedBuildWithMetrics) => savedBuildWithMetrics);
};

buildUtils.addExecutionsToBuild = (buildId, executions) => Build.findById(buildId)
  .populate('suites.executions')
  .then((build) => {
    if (executions && executions.length > 0) {
      executions.forEach((execution) => {
        execution.build = buildId;
        // check if suite exists.
        const buildSuite = build.suites
          .find((suite) => suite.name.toLowerCase() === execution.suite.toLowerCase());
        if (buildSuite === undefined) {
          log(`Creating suite ${execution.suite} for build ${build._id} and adding test ${execution._id}`);
          const newSuite = {
            name: execution.suite,
            executions: [],
          };
          newSuite.executions.push(execution);
          build.suites.push(newSuite);
        } else {
          log(`Adding test ${execution._id} to suite ${execution.suite} for build ${build._id}`);
          // if build suite exists add the test to it.
          buildSuite.push(execution);
        }
      });
      const buildWithMetrics = buildUtils.calculateBuildMetrics(build);
      return buildWithMetrics.save();
    }
    return build;
  });

buildUtils.calculateBuildMetrics = (build) => {
  build.result = new Map(buildUtils.defaultResultMap);
  build.end = undefined;
  build.status = defaultStatus;
  for (let i = 0, len = build.suites.length; i < len; i += 1) {
    let suite = build.suites[i];
    suite = buildUtils.calculateSuiteMetrics(suite);
    suite.result.forEach((value, key) => {
      build.result.set(key, build.result.get(key) + value);
    });
    log(`Build metrics for build ${build._id} are ${JSON.stringify(build.result)}`);
    if (build.end === undefined || build.end < suite.end) {
      build.end = suite.end;
    }
    if (build.start === undefined || build.start > suite.start) {
      build.start = suite.start;
    }
    build.status = buildUtils.determineNewState(build.status, suite.status);
  }
  return build;
};

buildUtils.calculateSuiteMetrics = (suite) => {
  suite.result = new Map(buildUtils.defaultResultMap);
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
    suite.status = buildUtils.determineNewState(suite.status, execution.status);
  }
  return suite;
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
      // check if the action contains steps, if not don't do anything
      if (currentAction.steps.length > 0) {
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
    }
    // update the test status based on the action states
    if (buildUtils.executionStates.indexOf(currentAction.status)
      > buildUtils.executionStates.indexOf(testExecution.status)) {
      // change the state as it's a 'higher' state.
      testExecution.status = currentAction.status;
    }
  }
};

buildUtils.determineNewState = (existingState, newState) => {
  if (buildUtils.executionStates.indexOf(existingState)
    > buildUtils.executionStates.indexOf(newState)) {
    return existingState;
  }
  return newState;
};

buildUtils.createExecution = (createExecution, build) => {
  const {
    title, suite, start, end, platforms, tags, meta, actions, feature,
  } = createExecution;

  const testExecution = new TestExecution({
    title,
    suite,
    build,
    feature,
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

buildUtils.createBuild = (name, component, start, environment, team, artifacts, phase) => {
  const build = new Build({
    environment,
    team,
    name,
    component,
    artifacts,
    suite: [],
    start,
    result: new Map(buildUtils.defaultResultMap),
  });
  if (phase) {
    build.phase = phase;
  }
  buildUtils.calculateBuildMetrics(build);
  return build;
};

module.exports = buildUtils;

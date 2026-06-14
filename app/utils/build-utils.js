const debug = require('debug');
const Build = require('../models/build.js');
const TestExecution = require('../models/execution.js');

const log = debug('metrics');
const buildMetricsUtils = {};

buildMetricsUtils.executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];
buildMetricsUtils.defaultResultMap = new Map([['PASS', 0], ['FAIL', 0], ['ERROR', 0], ['SKIPPED', 0]]);
const [defaultStatus] = buildMetricsUtils.executionStates;

buildMetricsUtils.addExecutionToBuild = async (buildOrId, execution, retries = 5) => {
  const buildId = buildOrId._id || buildOrId;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const build = await Build.findById(buildId).populate('suites.executions');
      if (!build) {
        throw new Error(`No build found with id ${buildId}`);
      }
      const buildSuite = build.suites
        .find((suite) => suite.name.toLowerCase() === execution.suite.toLowerCase());

      if (buildSuite === undefined) {
        log(`Creating suite ${execution.suite} for build ${build._id} and adding test ${execution._id}`);
        const newSuite = {
          name: execution.suite,
          executions: [execution],
        };
        build.suites.push(newSuite);
      } else {
        log(`Adding test ${execution._id} to suite ${execution.suite} for build ${build._id}`);
        const exists = buildSuite.executions.some((e) => {
          const eId = e._id ? e._id.toString() : e.toString();
          const execId = execution._id ? execution._id.toString() : execution.toString();
          return eId === execId;
        });
        if (!exists) {
          buildSuite.executions.push(execution);
        }
      }

      const buildWithMetrics = buildMetricsUtils.calculateBuildMetrics(build);
      log(`Update build (attempt ${attempt}): ${JSON.stringify(buildWithMetrics)}`);
      const savedBuild = await buildWithMetrics.save();
      return savedBuild;
    } catch (error) {
      const isVersionError = error.name === 'VersionError' || error.message.includes('No document found for query');
      if (isVersionError && attempt < retries) {
        log(`Version conflict for build ${buildId}, retrying attempt ${attempt + 1}...`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 5 + Math.random() * 45);
        });
        // eslint-disable-next-line no-continue
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to add execution to build ${buildId} after ${retries} attempts due to write conflicts.`);
};

buildMetricsUtils.calculateBuildMetrics = (build) => {
  build.result = new Map(buildMetricsUtils.defaultResultMap);
  build.end = undefined;
  build.status = defaultStatus;
  for (let i = 0, len = build.suites.length; i < len; i += 1) {
    let suite = build.suites[i];
    suite = buildMetricsUtils.calculateSuiteMetrics(suite);
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
      // check if the action contains steps, if not don't do anything
      if (currentAction.steps.length > 0) {
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
    title, suite, start, end, platforms, tags, meta, actions, feature,
  } = req.body;

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
    status: buildMetricsUtils.executionStates[0],
  });
  if (actions) {
    buildMetricsUtils.calculateExecutionMetrics(testExecution);
  }
  return testExecution;
};

module.exports = buildMetricsUtils;

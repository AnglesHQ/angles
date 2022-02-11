const buildMetricsUtils = require('./build-metrics.js');

const executionUtils = {};

executionUtils.saveExecutions = (suites, build) => {
  const executionPromises = [];
  if (suites && suites.length > 0) {
    suites.forEach((suite) => {
      suite.executions.forEach((createExecution) => {
        const testExecution = buildMetricsUtils.createExecution(createExecution, build);
        executionPromises.push(testExecution.save());
      });
    });
  }
  return Promise.all(executionPromises);
};

module.exports = executionUtils;

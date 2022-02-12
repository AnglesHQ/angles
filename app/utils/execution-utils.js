const buildUtils = require('./build-utils.js');

const executionUtils = {};

executionUtils.saveExecutions = (suites, build) => {
  const executionPromises = [];
  if (suites && suites.length > 0) {
    suites.forEach((suite) => {
      suite.executions.forEach((createExecution) => {
        const testExecution = buildUtils.createExecution(createExecution, build);
        executionPromises.push(testExecution.save());
      });
    });
  }
  return Promise.all(executionPromises);
};

module.exports = executionUtils;

const { validationResult } = require('express-validator');
const debug = require('debug');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');
const buildMetricsUtils = require('../utils/build-utils.js');
const { handleError, NotFoundError } = require('../exceptions/errors.js');

const log = debug('execution:controller');

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let testExecution;
  const { build: buildId } = req.body;
  return Build.findById(buildId)
    .populate('suites.executions')
    .then((buildFound) => {
      if (!buildFound) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      testExecution = buildMetricsUtils.createExecution(req, buildFound);
      return testExecution.save();
    })
    .then((savedExecution) => {
      testExecution = savedExecution;
      return buildMetricsUtils.addExecutionToBuild(testExecution.build, testExecution);
    })
    .then((savedBuild) => {
      testExecution.build = savedBuild._id;
      log(`Created test "${testExecution.title}", suite "${testExecution.suite}" build "${testExecution.build}", with id: "${testExecution._id}"`);
      return res.status(201).send(testExecution);
    })
    .catch((error) => handleError(error, res));
};

// TODO: handle returns
exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { buildId, executionIds } = req.query;
  if (buildId) {
    Build.findById(buildId)
      // .populate('suites.executions')
      .then((buildFound) => {
        if (!buildFound) {
          throw new NotFoundError(`No build found with id ${buildId}`);
        }
        const query = { build: buildFound };
        if (executionIds) {
          const executionIdArray = executionIds.split(',');
          query._id = { $in: executionIdArray };
        }
        return TestExecution.find(query);
      })
      .then((executionsFound) => {
        res.status(200).send(executionsFound);
      })
      .catch((err) => {
        handleError(err, res);
      });
  } else {
    // if no buildId provided
    const executionIdArray = executionIds.split(',');
    TestExecution.find({ _id: { $in: executionIdArray } })
      .then((testExecutions) => {
        res.status(200).send(testExecutions);
      })
      .catch((err) => {
        handleError(err, res);
      });
  }
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  return TestExecution.findById(executionId)
    .then((testExecution) => {
      if (!testExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      return res.status(200).send(testExecution);
    }).catch((err) => handleError(err, res));
};

exports.findHistory = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  return TestExecution.findById(executionId)
    .populate('build')
    .then((testExecution) => {
      if (!testExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      const limit = parseInt(req.query.limit, 10) || 20;
      const skip = parseInt(req.query.skip, 10) || 0;
      const query = {
        'build.team': testExecution.team,
        title: testExecution.title,
        suite: testExecution.suite,
      };

      const promises = [
        TestExecution.find(query, null, {
          sort: { _id: -1 },
          limit,
          skip,
        })
          .populate('build'),
        TestExecution.countDocuments(query)
          .exec(),
      ];
      return Promise.all(promises);
    })
    .then((results) => {
      const executions = results[0];
      const count = results[1];
      const response = { executions, count };
      return res.status(200).send(response);
    })
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  const { name } = req.body;
  return TestExecution.findByIdAndUpdate(executionId, {
    name,
  }, { new: true })
    .then((testExecution) => {
      if (!testExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      return res.status(200).send(testExecution);
    }).catch((err) => handleError(err, res));
};

exports.setPlatform = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  const { platforms } = req.body;
  return TestExecution.findByIdAndUpdate(executionId, {
    platforms,
  }, { new: true })
    .then((execution) => {
      if (!execution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      return res.status(200).send(execution);
    }).catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  return TestExecution.findByIdAndRemove(executionId)
    .then((testExecution) => {
      if (!testExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      return res.status(200).send({ message: 'Test execution deleted successfully!' });
    }).catch((err) => handleError(err, res));
};

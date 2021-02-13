const { validationResult } = require('express-validator');
const debug = require('debug');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');
const buildMetricsUtils = require('../utils/build-metrics.js');

const log = debug('execution:controller');

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let testExecution;
  return Build.findById(req.body.build)
    .populate('suites.executions')
    .then((buildFound) => {
      if (!buildFound) {
        const error = new Error(`No build found with id ${req.body.build}`);
        error.status = 404;
        return Promise.reject(error);
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
      res.status(201).send(testExecution);
    })
    .catch((error) => {
      if (error.status === 404) {
        res.status(404).send({
          message: error.message,
        });
      } else {
        res.status(500).send({
          message: `Error creating execution [${error}]`,
        });
      }
    });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId, executionIds } = req.query;
  if (buildId) {
    return Build.findById(buildId)
      // .populate('suites.executions')
      .then((buildFound) => {
        if (!buildFound) {
          const error = new Error(`No build found with id ${req.body.build}`);
          error.status = 404;
          return Promise.reject(error);
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
        res.status(500).send({
          message: err.message || 'Some error occurred while retrieving test executions.',
        });
      });
  }
  const executionIdArray = executionIds.split(',');
  return TestExecution.find({ _id: { $in: executionIdArray } })
    .then((testExecutions) => {
      res.status(200).send(testExecutions);
    }).catch((err) => {
      res.status(500).send({
        message: err.message || 'Some error occurred while retrieving test executions.',
      });
    });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return TestExecution.findById(req.params.executionId)
    .then((testExecution) => {
      if (!testExecution) {
        return res.status(404).send({
          message: `Execution not found with id ${req.params.executionId}`,
        });
      }
      return res.status(200).send(testExecution);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving team with id ${req.params.executionId} due to [${err}]`,
    }));
};

exports.findHistory = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  log(req.params.executionId);
  return TestExecution.findById(req.params.executionId)
    .populate('build')
    .then((testExecution) => {
      if (!testExecution) {
        return res.status(404).send({
          message: `Execution not found with id ${req.params.executionId}`,
        });
      }
      const limit = parseInt(req.query.limit, 10) || 20;
      const skip = parseInt(req.query.skip, 10) || 0;
      const query = { 'build.team': testExecution.team, title: testExecution.title, suite: testExecution.suite };
      return TestExecution.find(query, null, { sort: { _id: -1 }, limit, skip })
        .populate('build');
    }).then((testExecutions) => res.status(200).send(testExecutions))
    .catch((err) => res.status(500).send({
      message: `Error retrieving team with id ${req.params.executionId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  return TestExecution.findByIdAndUpdate(req.params.executionId, {
    name: req.body.name,
  }, { new: true })
    .then((testExecution) => {
      if (!testExecution) {
        return res.status(404).send({
          message: `Test execution not found with id ${req.params.executionId}`,
        });
      }
      return res.status(200).send(testExecution);
    }).catch((err) => res.status(500).send({
      message: `Error updating test execution with id ${req.params.executionId} due to [${err}]`,
    }));
};

exports.setPlatform = (req, res) => {
  // validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  // Find execution and update it with the request body
  return TestExecution.findByIdAndUpdate(req.params.executionId, {
    platforms: req.body.platforms,
  }, { new: true })
    .then((execution) => {
      if (!execution) {
        return res.status(404).send({
          message: `Execution not found with id ${req.params.executionId}`,
        });
      }
      return res.status(200).send(execution);
    }).catch((err) => res.status(500).send({
      message: `Error updating execution with id ${req.params.executionId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  // validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return TestExecution.findByIdAndRemove(req.params.executionId)
    .then((testExecution) => {
      if (!testExecution) {
        return res.status(404).send({
          message: `Test execution not found with id ${req.params.executionId}`,
        });
      }
      return res.status(200).send({ message: 'Test execution deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete test execution with id ${req.params.executionId} due to [${err}]`,
    }));
};

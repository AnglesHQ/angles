const { validationResult } = require('express-validator');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');
const buildUtils = require('../utils/process-builds.js');


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
      testExecution = buildUtils.createExecution(req, buildFound);
      return buildUtils.addExecutionToBuild(buildFound, testExecution);
    })
    .then((savedBuild) => {
      testExecution.build = savedBuild;
      return testExecution.save();
    })
    .then((savedTestExecution) => {
      res.status(201).send(savedTestExecution);
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
  TestExecution.find()
    .then((testExecutions) => {
      res.send(testExecutions);
    }).catch((err) => {
      res.status(500).send({
        message: err.message || 'Some error occurred while retrieving test executions.',
      });
    });
};

exports.findOne = (req, res) => {
  TestExecution.findById(req.params.executionId)
    .then((testExecution) => {
      if (!testExecution) {
        return res.status(404).send({
          message: `Execution not found with id ${req.params.executionId}`,
        });
      }
      return res.send(testExecution);
    }).catch((err) => {
      if (err.kind === 'ObjectId') {
        return res.status(404).send({
          message: `Team not found with id ${req.params.executionId}`,
        });
      }
      return res.status(500).send({
        message: `Error retrieving team with id ${req.params.executionId}`,
      });
    });
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
      return res.send(testExecution);
    }).catch((err) => {
      if (err.kind === 'ObjectId') {
        return res.status(404).send({
          message: `Test execution not found with id ${req.params.executionId}`,
        });
      }
      return res.status(500).send({
        message: `Error updating test execution with id ${req.params.executionId}`,
      });
    });
};

exports.delete = (req, res) => {
  TestExecution.findByIdAndRemove(req.params.executionId)
    .then((testExecution) => {
      if (!testExecution) {
        return res.status(404).send({
          message: `Test execution not found with id ${req.params.executionId}`,
        });
      }
      return res.send({ message: 'Test execution deleted successfully!' });
    }).catch((err) => {
      if (err.kind === 'ObjectId' || err.name === 'NotFound') {
        return res.status(404).send({
          message: `Test exection not found with id ${req.params.executionId}`,
        });
      }
      return res.status(500).send({
        message: `Could not delete test execution with id ${req.params.executionId}`,
      });
    });
};

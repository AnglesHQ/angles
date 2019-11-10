const { validationResult } = require('express-validator');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');

// Create and Save a new test execution
exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }

  return Build.findById(req.body.build)
    .then((buildFound) => {
      if (!buildFound) {
        return res.status(404).send({
          message: `No build found with id ${req.params.build}`,
        });
      }
      let addExecutionToBuild = function (buildToUpdate, execution, error, done) {
        // add the execution to the build
        console.info(buildToUpdate);
        buildToUpdate.executions.push(execution);
        buildToUpdate.save()
          .then((savedBuild) => {
            done(savedBuild);
          }).catch((err) => {
            error(err);
          });
      };
      const testExecution = new TestExecution({
        title: req.body.title,
        build: buildFound,
        status: 'SKIPPED',
        description: req.body.description,
      });
      return testExecution.save()
        .then((data) => {
          res.status(201).send(data);
        }).catch((err) => {
          res.status(500).send({
            message: err.message || 'Some error occurred while creating the build.',
          });
        });
    }).catch((err) => {
      if (err.kind === 'ObjectId') {
        return res.status(404).send({
          message: `No build found with id ${req.params.build}`,
        });
      }
      return res.status(500).send({
        message: `Error retrieving build with id ${req.params.build}`,
      });
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

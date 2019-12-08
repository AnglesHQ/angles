const { validationResult } = require('express-validator');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');

const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];


// Create and save a new test execution
exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }

  return Build.findById(req.body.build)
    .then((buildFound) => {
      if (!buildFound) {
        return res.status(404).send({
          message: `No build found with id ${req.body.build}`,
        });
      }

      // // add build to
      // let addExecutionToBuild = function (buildToUpdate, execution, error, done) {
      //   // add the execution to the build in the right suite!
      //   console.info(buildToUpdate);
      //   buildToUpdate.executions.push(execution);
      //   buildToUpdate.save()
      //     .then((savedBuild) => {
      //       done(savedBuild);
      //     }).catch((err) => {
      //       error(err);
      //     });
      // };

      // construct the execution to be stored.
      const testExecution = new TestExecution({
        // not all variables are mandatory as they can be passed through update.
        title: req.body.title,
        suite: req.body.suite,
        build: buildFound,
        start: req.body.start,
        end: req.body.end,
        platforms: req.body.platforms,
        tags: req.body.tags,
        meta: req.body.meta,
        status: executionStates[0],
      });

      // if there are already actions defined then update test exection
      if (req.body.actions) {
        testExecution.actions = req.body.actions;
        // go through all the actions and set the state and calculate metrics
        for (let i = 0, len = testExecution.actions.length; i < len; i += 1) {
          const currentAction = testExecution.actions[i];
          const defaultState = executionStates[0];
          currentAction.status = defaultState;
          if (currentAction.steps) {
            // go through all the steps and set the state of the action.
            for (let j = 0, stepLen = currentAction.steps.length; j < stepLen; j += 1) {
              const currentStep = currentAction.steps[j];
              if (executionStates.indexOf(currentStep.status)
                > executionStates.indexOf(currentAction.status)) {
                // change the state as it's a 'higher' state.
                currentAction.status = currentStep.status;
              }
            }
          }
          // update the test status based on the action states
          if (executionStates.indexOf(currentAction.status)
            > executionStates.indexOf(testExecution.status)) {
            // change the state as it's a 'higher' state.
            testExecution.status = currentAction.status;
          }
        }
      }

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
          message: `No build found with id ${req.body.build}`,
        });
      }
      return res.status(500).send({
        message: `Error retrieving build with id ${req.body.build}`,
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

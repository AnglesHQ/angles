const { validationResult } = require('express-validator');
const debug = require('debug');
const Environment = require('../models/environment.js');

const log = debug('environment:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  return Environment.where({ name: req.body.name })
    .findOne((searchErr, existingEnvironment) => {
      if (existingEnvironment) {
        return res.status(409).send({
          message: `Environment with name ${req.body.name} already exists.`,
        });
      }
      // create new environment
      const environment = new Environment({
        name: req.body.name,
      });

      // save the environment
      return environment.save()
        .then((data) => {
          log(`Created environment "${data.name}" with id: "${data._id}"`);
          return res.status(201).send(data);
        }).catch((err) => res.status(500).send({
          message: err.message || 'Some error occurred while creating the environment.',
        }));
    });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Environment.find()
    .then((environments) => res.send(environments))
    .catch((err) => res.status(500).send({
      message: err.message || 'Some error occurred while retrieving environments.',
    }));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Environment.findById(req.params.environmentId)
    .then((environment) => {
      if (!environment) {
        return res.status(404).send({
          message: `Environment not found with id ${req.params.environmentId}`,
        });
      }
      return res.send(environment);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving environment with id ${req.params.environmentId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Environment.where({ name: req.body.name }).findOne()
    .then((existingEnvironment) => {
      if (existingEnvironment) {
        return res.status(409).send({
          message: `Environment with name ${req.body.name} already exists.`,
        });
      }
      return Environment.findByIdAndUpdate(req.params.environmentId, {
        name: req.body.name,
      }, { new: true });
    })
    .then((environment) => {
      if (!environment) {
        return res.status(404).send({
          message: `Environment not found with id ${req.params.environmentId}`,
        });
      }
      return res.status(200).send(environment);
    })
    .catch((err) => res.status(500).send({
      message: `Error updating environment with id ${req.params.environmentId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Environment.findByIdAndRemove(req.params.environmentId)
    .then((environment) => {
      if (!environment) {
        return res.status(404).send({
          message: `Environment not found with id ${req.params.environmentId}`,
        });
      }
      return res.status(200).send({ message: 'Environment deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete environment with id ${req.params.environmentId} due to [${err}]`,
    }));
};

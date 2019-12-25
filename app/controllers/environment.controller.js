const { validationResult } = require('express-validator');
const Environment = require('../models/environment.js');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Environment.where({ name: req.body.name }).findOne((searchErr, existingEnvironment) => {
    if (existingEnvironment) {
      res.status(409).send({
        message: `Environment with name ${req.body.name} already exists.`,
      });
    } else {
      // create new environment
      const environment = new Environment({
        name: req.body.name,
      });

      // save the environment
      environment.save()
        .then((data) => {
          res.status(201).send(data);
        }).catch((err) => {
          res.status(500).send({
            message: err.message || 'Some error occurred while creating the environment.',
          });
        });
    }
  });
};

exports.findAll = (req, res) => {
  Environment.find()
    .then((environments) => {
      res.send(environments);
    }).catch((err) => {
      res.status(500).send({
        message: err.message || 'Some error occurred while retrieving environments.',
      });
    });
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
        const error = new Error(`Environment with name ${req.body.name} already exists.`);
        error.status = 409;
        return Promise.reject(error);
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
    .catch((err) => {
      if (err.status === 409) {
        return res.status(409).send({
          message: err.message,
        });
      }
      return res.status(500).send({
        message: `Error updating environment with id ${req.params.environmentId} due to [${err}]`,
      });
    });
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

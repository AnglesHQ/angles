const { validationResult } = require('express-validator');
const debug = require('debug');
const Environment = require('../models/environment.js');
const { handleError } = require('../exceptions/errors.js');
const { ConflictError, NotFoundError } = require('../exceptions/errors.js');

const log = debug('environment:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { name } = req.body;
  return Environment.findOne({ name }).exec()
    .then((existingEnvironment) => {
      if (existingEnvironment) {
        throw new ConflictError(`Environment with name ${name} already exists.`);
      }
      const environment = new Environment({
        name,
      });
      return environment.save();
    })
    .then((data) => {
      log(`Created environment "${data.name}" with id: "${data._id}".`);
      return res.status(201).send(data);
    })
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Environment.find()
    .then((environments) => {
      return res.status(200).send(environments);
    })
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { environmentId } = req.params;
  return Environment.findById(environmentId)
    .then((environment) => {
      if (!environment) {
        throw new NotFoundError(`Environment not found with id ${environmentId}`);
      }
      return res.status(200).send(environment);
    }).catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name } = req.body;
  const { environmentId } = req.params;
  return Environment.findOne({ name })
    .then((existingEnvironment) => {
      if (existingEnvironment) {
        throw new ConflictError(`Environment with name ${name} already exists.`);
      }
      return Environment.findByIdAndUpdate(environmentId, {
        name: req.body.name,
      }, { new: true });
    })
    .then((environment) => {
      if (!environment) {
        throw new NotFoundError(`Environment not found with id ${environmentId}`);
      }
      return res.status(200).send(environment);
    })
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { environmentId } = req.params;
  return Environment.findByIdAndRemove(environmentId)
    .then((environment) => {
      if (!environment) {
        throw new NotFoundError(`Environment not found with id ${environmentId}`);
      }
      return res.status(200).send({ message: 'Environment deleted successfully!' });
    }).catch((err) => handleError(err, res));
};

const { validationResult } = require('express-validator');
const debug = require('debug');
const Phase = require('../models/phase.js');

const log = debug('phase:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  return Phase.where({ name: req.body.name })
    .findOne((searchErr, existingPhase) => {
      if (existingPhase) {
        return res.status(409).send({
          message: `Phase with name ${req.body.name} already exists.`,
        });
      }
      const { name, orderNumber } = req.body;
      const phase = new Phase({
        name,
        orderNumber,
      });

      // save the phase
      return phase.save()
        .then((data) => {
          log(`Created phase "${data.name}" with id: "${data._id}"`);
          return res.status(201).send(data);
        }).catch((err) => res.status(500).send({
          message: err.message || 'Some error occurred while creating the phase.',
        }));
    });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Phase.find()
    .then((phases) => res.send(phases))
    .catch((err) => res.status(500).send({
      message: err.message || 'Some error occurred while retrieving phases.',
    }));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Phase.findById(req.params.phaseId)
    .then((phase) => {
      if (!phase) {
        return res.status(404).send({
          message: `Phase not found with id ${req.params.phaseId}`,
        });
      }
      return res.send(phase);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving phase with id ${req.params.phaseId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name, orderNumber } = req.body;
  let promise;
  let updateRequest = {};
  if (name) {
    updateRequest = { name };
    promise = Phase.where({ name }).findOne()
      .then((existingPhase) => {
        if (existingPhase) {
          return res.status(409).send({
            message: `Phase with name ${req.body.name} already exists.`,
          });
        }
        return true;
      });
  } else {
    promise = Promise.resolve(true);
  }
  return promise
    .then(() => {
      if (orderNumber) updateRequest.orderNumber = orderNumber;
      return Phase.findByIdAndUpdate(req.params.phaseId, updateRequest, { new: true });
    })
    .then((phase) => {
      if (!phase) {
        return res.status(404).send({
          message: `Phase not found with id ${req.params.phaseId}`,
        });
      }
      return res.status(200).send(phase);
    })
    .catch((err) => res.status(500).send({
      message: `Error updating phase with id ${req.params.phaseId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Phase.findByIdAndRemove(req.params.phaseId)
    .then((phase) => {
      if (!phase) {
        return res.status(404).send({
          message: `Phase not found with id ${req.params.phaseId}`,
        });
      }
      return res.status(200).send({ message: 'Phase deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete phase with id ${req.params.phaseId} due to [${err}]`,
    }));
};

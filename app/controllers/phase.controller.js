const { validationResult } = require('express-validator');
const debug = require('debug');
const Phase = require('../models/phase.js');
const { handleError, NotFoundError, ConflictError } = require('../exceptions/errors.js');

const log = debug('phase:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { name, orderNumber } = req.body;
  Phase
    .findOne({ name })
    .then((existingPhase) => {
      if (existingPhase) {
        throw new ConflictError(`Phase with name ${name} already exists.`);
      }
      const phase = new Phase({
        name,
        orderNumber,
      });

      // save the phase
      return phase.save();
    })
    .then((data) => {
      log(`Created phase "${name}" with id: "${data._id}"`);
      res.status(201).send(data);
    }).catch((err) => {
      handleError(err, res);
    });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  Phase.find({})
    .sort({ orderNumber: 1 })
    .then((phases) => {
      res.status(200).send(phases);
    })
    .catch((err) => {
      handleError(err, res);
    });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { phaseId } = req.params;
  Phase.findById(phaseId)
    .then((phase) => {
      if (!phase) {
        throw new NotFoundError(`Phase not found with id ${phaseId}`);
      }
      res.status(200).send(phase);
    }).catch((err) => {
      handleError(err, res);
    });
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { name, orderNumber } = req.body;
  const { phaseId } = req.params;
  let promise;
  let updateRequest = {};
  if (name) {
    updateRequest = { name };
    promise = Phase.findOne({ name })
      .then((existingPhase) => {
        if (existingPhase) {
          throw new ConflictError(`Phase with name ${name} already exists.`);
        }
        return true;
      });
  } else {
    promise = Promise.resolve(true);
  }
  promise
    .then(() => {
      if (orderNumber) updateRequest.orderNumber = orderNumber;
      return Phase.findByIdAndUpdate(phaseId, updateRequest, { new: true });
    })
    .then((phase) => {
      if (!phase) {
        throw new NotFoundError(`Phase not found with id ${req.params.phaseId}`);
      }
      res.status(200).send(phase);
    })
    .catch((err) => {
      handleError(err, res);
    });
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const { phaseId } = req.params;
  Phase.findByIdAndRemove(phaseId)
    .then((phase) => {
      if (!phase) {
        throw new NotFoundError(`Phase not found with id ${phaseId}`);
      }
      res.status(200).send({ message: 'Phase deleted successfully!' });
    }).catch((err) => {
      handleError(err, res);
    });
};

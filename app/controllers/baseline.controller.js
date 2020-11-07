const { validationResult } = require('express-validator');
const Baseline = require('../models/baseline.js');
const Screenshot = require('../models/screenshot.js');

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const promises = [
    Screenshot.findById(req.body.screenshotId).exec(),
    Baseline.findOne({ view: req.body.view, deviceName: req.body.deviceName }).exec(),
  ];
  return Promise.all(promises).then((results) => {
    const screenshot = results[0];
    const baselineFound = results[1];
    if (!screenshot) {
      return res.status(404).send({
        message: `No screenshot found with id ${req.body.screenshotId}`,
      });
    }
    if (baselineFound !== null) {
      return res.status(409).send({
        message: `Baseline for view [${baselineFound.view}] and device [${baselineFound.deviceName}] already exists`,
      });
    }
    // create the baseline.
    const baseline = new Baseline({
      screenshot,
      view: req.body.view,
      deviceName: req.body.deviceName,
      height: screenshot.height,
      width: screenshot.width,
    });
    return baseline.save();
  }).then((data) => {
    res.status(201).send(data);
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while creating the baseline.',
    });
  });
};

exports.findAll = (req, res) => {
  Baseline.find()
    .then((baselines) => {
      res.send(baselines);
    }).catch((err) => {
      res.status(500).send({
        message: err.message || 'Some error occurred while retrieving baselines.',
      });
    });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Baseline.findById(req.params.baselineId)
    .then((baseline) => {
      if (!baseline) {
        return res.status(404).send({
          message: `Baseline not found with id ${req.params.baselineId}`,
        });
      }
      return res.status(200).send(baseline);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving baseline with id ${req.params.baselineId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Screenshot.findById(req.body.screenshot)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshot}`,
        });
      }
      return Baseline.findByIdAndUpdate(req.params.baselineId, {
        screenshot,
      }, { new: true });
    })
    .then((baseline) => {
      if (!baseline) {
        return res.status(404).send({
          message: `Baseline not found with id ${req.params.baselineId}`,
        });
      }
      return res.status(200).send(baseline);
    }).catch((err) => res.status(500).send({
      message: `Error updating build with id ${req.params.baselineId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Baseline.findByIdAndRemove(req.params.baselineId)
    .then((baseline) => {
      if (!baseline) {
        return res.status(404).send({
          message: `Baseline not found with id ${req.params.baselineId}`,
        });
      }
      return res.status(200).send({ message: 'Baseline deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete baseline with id ${req.params.baselineId} due to [${err}]`,
    }));
};

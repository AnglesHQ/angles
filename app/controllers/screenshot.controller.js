const { validationResult } = require('express-validator');

const Screenshot = require('../models/screenshot.js');


exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  return res.status(201).send({ message: `File saved ${req.file.originalname} for build ${req.header('buildId')}` });
};

exports.createFail = (error, req, res, next) => {
  res.status(400).send({ error: error.message });
};

// exports.create = (req, res) => {
//   const errors = validationResult(req);
//   if (!errors.isEmpty()) {
//     return res.status(422).json({ errors: errors.array() });
//   }
//   // create new environment
//   const screenshot = new Screenshot({
//     name: req.body.name,
//   });
//
//   // save the environment
//   return screenshot.save()
//     .then((data) => {
//       res.status(201).send(data);
//     }).catch((err) => {
//       res.status(500).send({
//         message: err.message || 'Some error occurred while creating the environment.',
//       });
//     });
// };

exports.findAll = (req, res) => {
  Screenshot.find()
    .then((screenshots) => {
      res.send(screenshots);
    }).catch((err) => {
      res.status(500).send({
        message: err.message || 'Some error occurred while retrieving screenshots.',
      });
    });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Screenshot.findById(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      return res.status(200).send(screenshot);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  return Screenshot.findByIdAndUpdate(req.params.screenshotId, {
    name: req.body.name,
  }, { new: true })
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      return res.status(200).send(screenshot);
    })
    .catch((err) => res.status(500).send({
      message: `Error updating screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Screenshot.findByIdAndRemove(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      return res.status(200).send({ message: 'Screenshot deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

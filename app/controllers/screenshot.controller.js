const { validationResult } = require('express-validator');
const imageThumbnail = require('image-thumbnail');
const fs = require('fs');
const path = require('path');

const Screenshot = require('../models/screenshot.js');
const Build = require('../models/build.js');

exports.create = (req, res) => {
  const errors = validationResult(req);
  let build;
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Build.findById(req.headers.buildid)
    .then((foundBuild) => {
      if (!foundBuild) {
        const error = new Error(`No build found with id ${req.headers.buildid}`);
        error.status = 404;
        return Promise.reject(error);
      }
      build = foundBuild;
      const options = { width: 300, height: 300, responseType: 'base64' };
      return imageThumbnail(req.file.path, options);
    }).then((thumbnail) => {
      const screenshot = new Screenshot({
        build,
        timestamp: req.headers.timestamp,
        thumbnail,
        path: req.file.path,
      });
      return screenshot.save();
    })
    .then((savedScreenshot) => {
      res.status(201).send(savedScreenshot);
    })
    .catch((error) => {
      if (error.status === 404) {
        res.status(404).send({
          message: error.message,
        });
      } else {
        res.status(500).send({
          message: `Error creating screenshot [${error}]`,
        });
      }
    });
};

exports.createFail = (error, req, res) => {
  res.status(400).send({ error: error.message });
};

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

exports.findOneImage = (req, res) => {
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
      return res.sendFile(path.resolve(`${screenshot.path}`));
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
      fs.unlinkSync(screenshot.path);
      return res.status(200).send({ message: 'Screenshot deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

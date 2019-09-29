const Build = require('../models/build.js');
const uuidv4 = require('uuid/v4')
const { check, validationResult } = require('express-validator');

// Create and Save a new Note
exports.create = (req, res) => {
    // Finds the validation errors in this request and wraps them in an object with handy functions
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }
    var build = new Build({
      environment: req.body.environment,
      team: req.body.team
    });

    //save the build
    build.save()
    .then(data => {
        res.send(data);
    }).catch(err => {
        res.status(500).send({
            message: err.message || "Some error occurred while creating the build."
        });
    });
};

exports.findAll = (req, res) => {
  Build.find()
  .then(builds => {
     res.send(builds);
  }).catch(err => {
     res.status(500).send({
         message: err.message || "Some error occurred while retrieving builds."
     });
  });
};

exports.findOne = (req, res) => {
    Build.findById(req.params.buildId)
    .then(build => {
        if(!build) {
            return res.status(404).send({
                message: "Build not found with id " + req.params.buildId
            });
        }
        res.send(build);
    }).catch(err => {
        if(err.kind === 'ObjectId') {
            return res.status(404).send({
                message: "Build not found with id " + req.params.buildId
            });
        }
        return res.status(500).send({
            message: "Error retrieving build with id " + req.params.buildId
        });
    });
};

exports.update = (req, res) => {
  // validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  // Find build and update it with the request body
  Build.findByIdAndUpdate(req.params.buildId, {
      team: req.body.team,
      environment: req.body.environment
  }, {new: true})
  .then(build => {
      if(!build) {
          return res.status(404).send({
              message: "Build not found with id " + req.params.buildId
          });
      }
      res.send(build);
  }).catch(err => {
      if(err.kind === 'ObjectId') {
          return res.status(404).send({
              message: "Build not found with id " + req.params.buildId
          });
      }
      return res.status(500).send({
          message: "Error updating build with id " + req.params.buildId
      });
  });
};

// Delete a build with the specified build in the request
exports.delete = (req, res) => {
  Build.findByIdAndRemove(req.params.buildId)
  .then(build => {
      if(!build) {
          return res.status(404).send({
              message: "Build not found with id " + req.params.buildId
          });
      }
      res.send({message: "Build deleted successfully!"});
  }).catch(err => {
      if(err.kind === 'ObjectId' || err.name === 'NotFound') {
          return res.status(404).send({
              message: "Build not found with id " + req.params.buildId
          });
      }
      return res.status(500).send({
          message: "Could not delete build with id " + req.params.buildId
      });
  });
};

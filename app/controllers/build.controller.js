const Build = require('../models/build.js');
const Team = require('../models/team.js');
const Environment = require('../models/environment.js');
const uuidv4 = require('uuid/v4')
const { check, validationResult } = require('express-validator');

// Create and Save a new Note
exports.create = (req, res) => {
  // Finds the validation errors in this request and wraps them in an object with handy functions
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  //check the variables provided are real
  var promises = [
    Team.findOne({ 'name': req.body.team }).exec(),
    Environment.findOne({ 'name': req.body.environment }).exec()
  ];

  Promise.all(promises).then(function(results) {
    var teamFound = results[0];
    var environmentFound = results[1];
    //check team
    if (teamFound == null || teamFound == undefined) {
      res.status(404).send({
          message: "No team found with name " + req.body.team
      });
    //check environment
  } else if (environmentFound == null || environmentFound == undefined) {
      res.status(404).send({
        message: "No environment found with name " + req.body.environment
      });
    } else {
      //valid details, save build
      var build = new Build({
        environment: environmentFound,
        team: teamFound,
        name: req.body.name
      });
      //save the build
      build.save()
      .then(data => {
          res.status(201).send(data);
      }).catch(err => {
          res.status(500).send({
              message: err.message || "Some error occurred while creating the build."
          });
      });
    }
  }).catch(function(err){
    res.status(500).send({
        message: err.message || "Some error occurred while creating the build."
    });
  });
};

exports.findAll = (req, res) => {
  Build.find()
  .populate('team')
  .populate('environment')
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
    .populate('team')
    .populate('environment')
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

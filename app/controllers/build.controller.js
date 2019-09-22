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
    var build = new Build();
    build.id = mongoose.Types.ObjectId();
    res.json({"id": build.id});
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

// // Update a note identified by the noteId in the request
// exports.update = (req, res) => {
//
// };

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

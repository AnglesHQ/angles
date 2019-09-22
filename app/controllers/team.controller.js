const Team = require('../models/team.js');
const uuidv4 = require('uuid/v4')
const { check, validationResult } = require('express-validator');

// Create and Save a new team
exports.create = (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }
    var team = new Team();
    team.id = mongoose.Types.ObjectId();
    res.json({"id": team.id});
};

exports.findAll = (req, res) => {
  Team.find()
  .then(teams => {
     res.send(teams);
  }).catch(err => {
     res.status(500).send({
         message: err.message || "Some error occurred while retrieving teams."
     });
  });
};

exports.findOne = (req, res) => {
    Team.findById(req.params.teamId)
    .then(team => {
        if(!team) {
            return res.status(404).send({
                message: "Team not found with id " + req.params.teamId
            });
        }
        res.send(team);
    }).catch(err => {
        if(err.kind === 'ObjectId') {
            return res.status(404).send({
                message: "Team not found with id " + req.params.teamId
            });
        }
        return res.status(500).send({
            message: "Error retrieving team with id " + req.params.teamId
        });
    });
};

exports.delete = (req, res) => {
  Team.findByIdAndRemove(req.params.teamId)
  .then(team => {
      if(!team) {
          return res.status(404).send({
              message: "Team not found with id " + req.params.teamId
          });
      }
      res.send({message: "Team deleted successfully!"});
  }).catch(err => {
      if(err.kind === 'ObjectId' || err.name === 'NotFound') {
          return res.status(404).send({
              message: "Team not found with id " + req.params.teamId
          });
      }
      return res.status(500).send({
          message: "Could not delete team with id " + req.params.teamId
      });
  });
};

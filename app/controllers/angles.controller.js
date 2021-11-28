const { validationResult } = require('express-validator');
const debug = require('debug');
const mongoose = require('mongoose');
const { version } = require('../../package.json');

const log = debug('angles:controller');

exports.versions = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return mongoose.connection.db.command({ buildInfo: 1 })
    .then((info) => {
      const response = {
        node: process.versions.node,
        mongo: info.version,
        angles: version,
      };
      return res.status(200).send(response);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving versions ${err}`,
    }));
};

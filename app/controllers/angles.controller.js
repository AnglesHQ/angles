const { validationResult } = require('express-validator');
const debug = require('debug');
const mongoose = require('mongoose');
// eslint-disable-next-line import/extensions
const { version } = require('../../package.json');
const { handleError } = require('../exceptions/errors.js');

// eslint-disable-next-line no-unused-vars
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
    }).catch((err) => {
      return handleError(err, res);
    });
};

const anglesController = require('../controllers/angles.controller.js');

module.exports = (app, path) => {
  app.get(`${path}/angles/versions`, [
  ], anglesController.versions);
};

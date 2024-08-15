const anglesController = require('../controllers/angles.controller.js');
const keycloak = require('../../middlewares/keycloak.js');
const extractToken = require('../../middlewares/extractToken.js');
const checkIfAdmin = require('../../middlewares/checkIfAdmin.js');

module.exports = (app, path) => {
  app.get(`${path}/angles/versions`, [
    keycloak.protect(),
    extractToken,
    checkIfAdmin,
  ], anglesController.versions);
};

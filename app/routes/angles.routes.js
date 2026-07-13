const anglesController = require('../controllers/angles.controller.js');
const authMiddleware = require('../utils/auth-middleware.js');

module.exports = (app, path) => {
  app.get(`${path}/angles/versions`, authMiddleware.preventTokenAuth, anglesController.versions);
};

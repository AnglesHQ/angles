const users = require('../controllers/user.controller');
const authMiddleware = require('../utils/auth-middleware');

module.exports = (app, path) => {
  // Protect all user management routes, require admin
  app.use(`${path}/users`, authMiddleware.isAuthenticated, authMiddleware.authorizeAdmin);

  app.post(`${path}/users`, users.create);
  app.get(`${path}/users`, users.findAll);
  app.get(`${path}/users/:userId`, users.findOne);
  app.put(`${path}/users/:userId`, users.update);
  app.delete(`${path}/users/:userId`, users.delete);
};

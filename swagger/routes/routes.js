module.exports = (app) => {

  const { check, validationResult } = require('express-validator');
  var swaggerUi = require('swagger-ui-express'),
      swaggerDocument = require('../swagger.json');

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

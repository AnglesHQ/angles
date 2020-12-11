const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');

module.exports = (app) => {
  if (process.env.REACT_APP_SWAGGER_ANGLES_API_URL) {
    swaggerDocument.host = process.env.REACT_APP_SWAGGER_ANGLES_API_URL;
  }
  if (process.env.REACT_APP_SWAGGER_SCHEMES) {
    swaggerDocument.schemes = process.env.REACT_APP_SWAGGER_SCHEMES.split(',');
  }
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
};

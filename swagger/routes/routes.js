const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');

module.exports = (app) => {
  let scheme = 'http';
  if (process.env.REACT_APP_SWAGGER_SCHEMES) {
    scheme = process.env.REACT_APP_SWAGGER_SCHEMES.split(',')[0].trim();
  }

  let host = '127.0.0.1:3000';
  if (process.env.REACT_APP_SWAGGER_ANGLES_API_URL) {
    host = process.env.REACT_APP_SWAGGER_ANGLES_API_URL;
  }

  const serverUrl = host.startsWith('http') ? host : `${scheme}://${host}`;

  swaggerDocument.servers = [
    {
      url: `${serverUrl}/rest/api/v1.0`,
      description: 'Angles API Server'
    }
  ];

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
};

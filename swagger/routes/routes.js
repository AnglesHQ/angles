const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');

module.exports = (app) => {
  let scheme = 'http';
  if (process.env.SWAGGER_SCHEMES) {
    scheme = process.env.SWAGGER_SCHEMES.split(',')[0].trim();
  }

  let host = '127.0.0.1:3000';
  if (process.env.ANGLES_API_BASE_URL) {
    if (process.env.ANGLES_API_BASE_PATH) {
      host = `${process.env.ANGLES_API_BASE_URL}${process.env.ANGLES_API_BASE_PATH}`;
    } else {
      host = process.env.ANGLES_API_BASE_URL;
    }
  }

  const serverUrl = host.startsWith('http') ? host : `${scheme}://${host}`;

  // build the served spec from a shallow copy; require() caches swagger.json and
  // returns a shared object, so mutating it would leak to any other consumer.
  const document = {
    ...swaggerDocument,
    servers: [
      {
        url: `${serverUrl}`,
        description: 'Angles API Server',
      },
    ],
  };

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(document));
};

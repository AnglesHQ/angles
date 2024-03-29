const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const pino = require('pino');
const expressPino = require('express-pino-logger');
// mongo db config
const mongoose = require('mongoose');
const path = require('path');
const dbConfig = require('./config/database.config.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const expressLogger = expressPino({ logger });
const mongoURL = process.env.MONGO_URL || dbConfig.url;

// create express app
const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(compression());

// parse requests of content-type - application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true }));

// parse requests of content-type - application/json
app.use(bodyParser.json({ limit: '50mb' }));

// use the pino logger
app.use(expressLogger);

// Configuring the database
mongoose.Promise = global.Promise;

// Connecting to the database
mongoose.connect(mongoURL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  logger.info('Successfully connected to the database');
}).catch((err) => {
  logger.error('Could not connect to the database. Exiting now...', err);
  process.exit();
});

// needed for reporting
app.set('views', path.join(__dirname, 'app/assets/report'));
app.set('view engine', 'pug');
app.locals.moment = require('moment');

// Add swagger routes
require('./swagger/routes/routes.js')(app);

// Add routes to server
require('./app/routes/environment.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/team.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/phase.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/build.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/execution.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/screenshot.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/baseline.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/metrics.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/angles.routes.js')(app, '/rest/api/v1.0');

// listen for requests
module.exports = app.listen(PORT, () => {
  logger.info('Server is listening on port %d', PORT);
});

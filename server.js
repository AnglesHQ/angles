const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const pino = require('pino');
const expressPino = require('express-pino-logger');
const session = require('express-session');
const MongoStore = require('connect-mongo').default || require('connect-mongo');
const passport = require('passport');
const authConfig = require('./config/auth.config.js');
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

const corsOptionsDelegate = (req, callback) => {
  const origin = req.header('Origin');
  let corsOptions = {
    credentials: true,
  };

  if (origin) {
    try {
      const originUrl = new URL(origin);
      const isLocal = (host) => host === 'localhost' || host === '127.0.0.1';
      const isSameHost = originUrl.hostname === req.hostname || (isLocal(originUrl.hostname) && isLocal(req.hostname));

      if (isSameHost) {
        corsOptions.origin = true;
      } else {
        corsOptions.origin = false;
        corsOptions.credentials = false;
      }
    } catch (e) {
      corsOptions.origin = false;
      corsOptions.credentials = false;
    }
  } else {
    corsOptions.origin = false;
  }

  callback(null, corsOptions);
};

app.use(cors(corsOptionsDelegate));
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
mongoose.set('strictQuery', false);
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

// Setup Session and Passport
app.use(session({
  secret: authConfig.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoURL }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
  },
}));

require('./app/utils/passport-setup.js');
app.use(passport.initialize());
app.use(passport.session());

// Add swagger routes
require('./swagger/routes/routes.js')(app);

// Add auth routes (unprotected)
require('./app/routes/auth.routes.js')(app, '/rest/api/v1.0');

// Global authentication middleware for API routes
const authMiddleware = require('./app/utils/auth-middleware.js');
app.use('/rest/api/v1.0', authMiddleware.isAuthenticated);

// Add user routes
require('./app/routes/user.routes.js')(app, '/rest/api/v1.0');

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

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const pino = require('pino');
const expressPino = require('express-pino-logger');
const session = require('express-session');
// connect-mongo exports differently across versions; support both shapes.
// eslint-disable-next-line global-require
const MongoStore = require('connect-mongo').default || require('connect-mongo');
const passport = require('passport');
const mongoose = require('mongoose');
const path = require('path');
const authConfig = require('./config/auth.config.js');
// requiring passport-setup registers the local strategy (side effect) and exposes the
// provider strategy registry, (re)configured after the DB settings load.
const { configureProviders } = require('./app/utils/passport-setup.js');
const authSettingsService = require('./app/utils/auth-settings-service.js');
const adminSeedService = require('./app/utils/admin-seed-service.js');
// mongo db config
const dbConfig = require('./config/database.config.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const expressLogger = expressPino({ logger });
const mongoURL = process.env.MONGO_URL || dbConfig.url;

// create express app
const PORT = process.env.PORT || 3000;
const app = express();

const corsOptionsDelegate = (req, callback) => {
  const origin = req.header('Origin');
  const corsOptions = {
    credentials: true,
  };

  if (origin) {
    try {
      const originUrl = new URL(origin);
      const isLocal = (host) => host === 'localhost' || host === '127.0.0.1';
      const isSameHost = originUrl.hostname === req.hostname
        || (isLocal(originUrl.hostname) && isLocal(req.hostname));

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

// Request instrumentation for the Prometheus endpoint. Registered before the routes so it
// observes every request, and before the body parsers so the recorded duration includes
// the time spent reading and parsing the body (which is most of a screenshot upload).
const httpMetrics = require('./app/utils/http-metrics.js');

app.use(httpMetrics.middleware);

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
}).then(async () => {
  logger.info('Successfully connected to the database');
  // Seed the initial admin account from the deployment-provided password env var
  // (create-if-missing; see admin-seed-service).
  try {
    const result = await adminSeedService.ensureAdminUser();
    if (result.seeded) {
      logger.info('Seeded initial admin user "%s"', result.username);
    } else if (result.reason === 'no-password') {
      logger.warn('ANGLES_ADMIN_PASSWORD is not set; no admin user was seeded');
    } else if (result.reason === 'weak-password') {
      logger.warn('ANGLES_ADMIN_PASSWORD does not meet the strength policy (must %s); no admin user was seeded', result.violations.join(', '));
    }
  } catch (err) {
    logger.error('Could not seed admin user', err);
  }
  // Load persisted auth settings (migrating a legacy single-Okta document on first run)
  // and build the strategy for every enabled provider so database-managed values take
  // effect. A provider that fails to configure is logged and left unregistered rather
  // than preventing startup.
  try {
    await authSettingsService.loadAuthSettings();
    const providerResults = await configureProviders();
    providerResults.filter((result) => result.error).forEach((result) => {
      logger.warn('Auth provider "%s" could not be configured: %s', result.id, result.error);
    });
    logger.info('Auth settings loaded (%d provider(s) active)', providerResults.filter((r) => r.ok).length);
  } catch (err) {
    logger.error('Could not load auth settings', err);
  }
}).catch((err) => {
  logger.error('Could not connect to the database. Exiting now...', err);
  process.exit();
});

// needed for reporting
app.set('views', path.join(__dirname, 'app/assets/report'));
app.set('view engine', 'pug');
app.locals.moment = require('moment');

// Setup Session and Passport
// Behind a TLS-terminating reverse proxy, express needs to trust X-Forwarded-* to know the
// original request was HTTPS; without it a `secure` session cookie is never set.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: authConfig.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoURL }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
    httpOnly: true, // keep the cookie away from client-side JavaScript
    sameSite: 'lax', // do not send the session cookie on cross-site requests
    // Opt-in rather than derived from NODE_ENV: when the app runs behind a TLS-terminating
    // proxy, `secure` only works together with the `trust proxy` setting below, and turning
    // it on unconditionally would stop the cookie being set at all. Deployments that serve
    // over HTTPS should set SECURE_COOKIES=true.
    secure: process.env.SECURE_COOKIES === 'true',
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Add swagger routes
require('./swagger/routes/routes.js')(app);

// Prometheus scrape endpoint. Mounted at the root and registered before the
// `/rest/api/v1.0` authentication middleware, because Prometheus authenticates with its
// own bearer token rather than a session; the route applies that check itself. Disabled
// unless ANGLES_METRICS_TOKEN or ANGLES_METRICS_PUBLIC is set.
require('./app/routes/prometheus.routes.js')(app);

// Start sampling event loop lag (an unref()ed interval, so it never holds the process open)
require('./app/utils/resource-metrics.js').startEventLoopMonitor();

// Add auth routes (unprotected)
require('./app/routes/auth.routes.js')(app, '/rest/api/v1.0');

// Global authentication middleware for API routes
const authMiddleware = require('./app/utils/auth-middleware.js');

app.use('/rest/api/v1.0', authMiddleware.isAuthenticated);

// Add user routes
require('./app/routes/user.routes.js')(app, '/rest/api/v1.0');

// Add settings routes (admin-only)
require('./app/routes/settings.routes.js')(app, '/rest/api/v1.0');

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

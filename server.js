const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// mongo db config
const mongoose = require('mongoose');
const dbConfig = require('./config/database.config.js');

// create express app
const app = express();
app.use(cors());

// parse requests of content-type - application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true }));

// parse requests of content-type - application/json
app.use(bodyParser.json());

// Configuring the database
mongoose.Promise = global.Promise;

// Connecting to the database
mongoose.connect(dbConfig.url, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useCreateIndex: true,
  useFindAndModify: false,
}).then(() => {
  console.log('Successfully connected to the database');
}).catch((err) => {
  console.log('Could not connect to the database. Exiting now...', err);
  process.exit();
});

// Add swagger routes
require('./swagger/routes/routes.js')(app);

// Add routes to server
require('./app/routes/environment.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/team.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/build.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/execution.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/screenshot.routes.js')(app, '/rest/api/v1.0');
require('./app/routes/baseline.routes.js')(app, '/rest/api/v1.0');

// listen for requests
module.exports = app.listen(3000, () => {
  console.log('Server is listening on port 3000');
});

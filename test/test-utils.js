const debug = require('debug');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');
const Build = require('../app/models/build.js');
const buildUtils = require('../app/utils/build-utils.js');

const logger = debug('testUtils');
const baseUrl = '/rest/api/v1.0/';

// Shared admin credentials for the test suites. The admin account used to be seeded by
// setup/mongo-init.js; that now delegates admin creation to the app (from an env var,
// subject to the password policy), so the tests provision their own policy-compliant admin.
const ADMIN_USERNAME = 'test-admin';
const ADMIN_PASSWORD = 'Test-Admin-Pass1!';

const createdObjects = [];
const testUtils = {};
const [defaultStatus] = buildUtils.executionStates;

testUtils.ADMIN_USERNAME = ADMIN_USERNAME;
testUtils.ADMIN_PASSWORD = ADMIN_PASSWORD;

// Ensures the shared admin account exists (create-if-missing), so the suites can log in
// without depending on an externally seeded admin.
testUtils.seedAdminUser = async () => {
  const existing = await User.findOne({ username: ADMIN_USERNAME });
  if (!existing) {
    const password = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await User.create({
      username: ADMIN_USERNAME, password, role: 'admin', authProvider: 'local',
    });
  }
};

// Memoized so every test file shares a single logged-in admin session
// instead of re-authenticating once per suite.
let adminAgentPromise = null;

testUtils.getAdminAgent = () => {
  if (!adminAgentPromise) {
    adminAgentPromise = testUtils.seedAdminUser().then(() => new Promise((resolve, reject) => {
      const agent = request.agent(app);
      agent
        .post(`${baseUrl}auth/login`)
        .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
        .end((err) => (err ? reject(err) : resolve(agent)));
    }));
  }
  return adminAgentPromise;
};

testUtils.createTeam = (name, componentName) => {
  // instantiate a test team
  const team = new Team({
    name: name || 'unit-testing-team',
    components: [{ name: componentName || 'build-component' }],
  });
  createdObjects.push(team);
  return team.save();
};

testUtils.createEnvironment = (name) => {
  // instantiate a test environment
  const environment = new Environment({
    name: name || 'unit-testing-environment',
  });
  createdObjects.push(environment);
  return environment.save();
};

testUtils.createBuild = (team, environment, name) => {
  const build = new Build({
    name,
    team,
    environment,
    status: defaultStatus,
    component: team.components[0],
    suite: [],
    result: new Map(buildUtils.defaultResultMap),
  });
  createdObjects.push(build);
  return build.save();
};

testUtils.cleanUp = () => {
  createdObjects.forEach((item) => {
    item.remove();
  });
};

module.exports = testUtils;

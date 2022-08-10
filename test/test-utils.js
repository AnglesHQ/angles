const debug = require('debug');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');
const Build = require('../app/models/build.js');
const buildUtils = require('../app/utils/build-utils.js');

const logger = debug('testUtils');

const createdObjects = [];
const testUtils = {};
const [defaultStatus] = buildUtils.executionStates;

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

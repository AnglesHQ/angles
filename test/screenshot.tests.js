const request = require('supertest');
const pino = require('pino');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const Screenshot = require('../app/models/screenshot.js');
const { Team } = require('../app/models/team.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let build;
let screenshot;

describe('Screenshot API Tests', () => {
  before((done) => {
    // clear lingering test screenshots
    const clearingPromises = [
      Screenshot.deleteMany({ view: /^unit-testing-view/ }).exec(),
      Build.deleteMany({ name: /^build-unit-testing/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-environment/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-team/ }).exec(),
    ];
    Promise.all(clearingPromises).then(() => {
      logger.info('Cleared any lingering test screenshots');
      const createPromises = [
        testUtils.createTeam('unit-testing-team-screenshot'),
        testUtils.createEnvironment('unit-testing-environment-screenshot'),
      ];
      Promise.all(createPromises)
        .then((result) => testUtils
          .createBuild(result[0], result[1], 'build-unit-testing-screenshot'))
        .then((createBuild) => {
          build = createBuild;
          done();
        })
        .catch((exception) => {
          logger(exception);
          done();
        });
    });
  });

  after(() => {
    if (screenshot) {
      Screenshot.deleteOne({ _id: screenshot._id });
    }
    testUtils.cleanUp();
  });

  describe('POST /screenshot', () => {
    it('successfully create store a screenshot', (done) => {
      // logger('during');
      request(app)
        .post(`${baseUrl}screenshot`)
        .set('Content-Type', 'multipart/form-data')
        .set('Accept', 'application/json')
        .field('buildId', build.id)
        .field('timestamp', (new Date()).toISOString())
        .field('view', 'unit-testing-view')
        .attach('screenshot', './test/resources/angles_home_page.jpg')
        .expect('Content-Type', /json/)
        .end((err, res) => {
          if (err) return done(err);
          res.body._id.should.match(/[a-f\d]{24}/);
          screenshot = res.body;
          return done();
        });
    });
  });
});

const request = require('supertest');
const should = require('should');
const randomstring = require('randomstring');
const pino = require('pino');
const app = require('../server.js');
const Execution = require('../app/models/execution.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');
const Build = require('../app/models/build.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let environment;
let team;
let build;
let testbuild = null;

describe('Execution API Tests', () => {
  before((done) => {
    // do the setup required for all tests
    Execution.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        logger.error('Error occured whilst clearing test executions', err);
      } else {
        logger.info('Cleared any lingering test executions');
      }
    });

    // setup the build for testing.
    team = new Team({
      name: `unit-testing-team-${randomstring.generate(5)}`,
      components: [{ name: 'component' }],
    });
    environment = new Environment({
      name: `unit-testing-environment-${randomstring.generate(5)}`,
    });
    const promises = [
      team.save(),
      environment.save(),
    ];
    Promise.all(promises).then((results) => {
      const createdTeam = results[0];
      const createdEnvironment = results[1];
      build = new Build({
        environment: createdEnvironment,
        team: createdTeam,
        component: createdTeam.components[0],
        name: 'unit-testing-build',
        executions: [],
        status: 'SKIPPED',
      });
      build.save((error, savedBuild) => {
        testbuild = savedBuild;
        done();
      });
    }).catch((err) => {
      logger.error(err);
    });
  });
  after(() => {
    // tear down
    team.remove();
    environment.remove();
    // build.remove();
  });

  describe('GET /execution for a specific build', () => {
    it('respond with json containing a list of all executions', (done) => {
      request(app)
        .get(`${baseUrl}execution?buildId=${testbuild._id}`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
    // add a build and ensure it's returned in the the full list.
  });

  // describe('POST /execution', () => {
  //   it('successfully create execution with valid details', (done) => {
  //     const createTestExecutionRequest = {
  //       title: 'unit-testing-execution-test',
  //       description: 'unit-testing-description',
  //       suite: 'unit-testing-suite',
  //       build: testbuild._id,
  //     };
  //     console.log(testbuild);
  //     request(app)
  //       .post(`${baseUrl}execution`)
  //       .send(createTestExecutionRequest)
  //       .set('Accept', 'application/json')
  //       .expect('Content-Type', /json/)
  //       .expect(201)
  //       .end((err, res) => {
  //         console.log(err);
  //         if (err) return done(err);
  //         res.body._id.should.match(/[a-f\d]{24}/);
  //         return done();
  //       });
  //   });
  // });

  describe('POST /execution - negative tests', () => {
    it('respond with 422 when trying to create a test execution with a invalid buildId', (done) => {
      const negativeRequest = {
        title: 'unit-testing-execution-test',
        suite: 'unit-testing-suite',
        build: '123',
      };
      request(app)
        .post(`${baseUrl}execution`)
        .send(negativeRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });
  });
});

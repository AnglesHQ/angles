/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] } ] */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "should" } ] */

const request = require('supertest');
const should = require('should');
const randomstring = require('randomstring');
const app = require('../server.js');
const Execution = require('../app/models/execution.js');
const Environment = require('../app/models/environment.js');
const Team = require('../app/models/team.js');
const Build = require('../app/models/build.js');

const baseUrl = '/rest/api/v1.0/';
let testbuild = null;

describe('Execution API Tests', () => {
  before(() => {
    // do the setup required for all tests
    Execution.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        console.log(err);
      } else {
        console.log('Cleared any lingering test executions');
      }
    });

    // setup the build for testing.
    const team = new Team({
      name: `unit-testing-team-${randomstring.generate(5)}`,
      components: [{ name: 'component', features: ['feature'] }],
    });
    const environment = new Environment({
      name: `unit-testing-environment-${randomstring.generate(5)}`,
    });
    const promises = [
      team.save(),
      environment.save(),
    ];
    return Promise.all(promises).then((results) => {
      const createdTeam = results[0];
      const createdEnvironment = results[1];
      const build = new Build({
        environment: createdEnvironment,
        team: createdTeam,
        name: 'unit-testing-build',
        executions: [],
      });
      build.save().then((createdBuild) => {
        testbuild = createdBuild;
      });
    }).catch((err) => {
      console.error(err);
    });
  });

  describe('GET /execution', () => {
    it('respond with json containing a list of all executions', (done) => {
      request(app)
        .get(`${baseUrl}execution`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
    // add a build and ensure it's returned in the the full list.
  });

  describe('POST /execution', () => {
    it('succesfully create execution with valid details', (done) => {
      const createTestExecutionRequest = {
        title: 'unit-testing-execution-test',
        description: 'unit-testing-description',
        suite: 'unit-testing-suite',
        build: testbuild._id,
      };
      request(app)
        .post(`${baseUrl}execution`)
        .send(createTestExecutionRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          if (err) return done(err);
          res.body._id.should.match(/[a-f\d]{24}/);
          return done();
        });
    });
  });

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

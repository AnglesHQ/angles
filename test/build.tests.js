const request = require('supertest');
const should = require('should');
const pino = require('pino');
const app = require('../server.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let team;
let environment;
let createdBuild;

describe('Build API Tests', () => {
  before((done) => {
    const clearingPromises = [
      Team.deleteMany({ name: 'build-unit-testing-team' }).exec(),
      Environment.deleteMany({ name: 'build-unit-testing-environment' }).exec(),
    ];
    Promise.all(clearingPromises).then(() => {
      // instantiate a test team
      team = new Team({
        name: 'build-unit-testing-team',
        components: [{ name: 'build-component' }],
      });
      // instantiate a test environment
      environment = new Environment({
        name: 'build-unit-testing-environment',
      });
      const savePromises = [
        team.save(),
        environment.save(),
      ];
      Promise.all(savePromises).then(() => {
        logger.info('Created required environment and team for build tests.');
        done();
      });
    });
  });
  after(() => {
    // teardown
    team.remove();
    environment.remove();
    Build.remove({ _id: createdBuild._id });
  });

  describe('POST /build', () => {
    it('successfully create build with valid details', (done) => {
      const createBuildRequest = {
        environment: environment.name,
        team: team.name,
        name: 'build-unit-testing-build',
        component: team.components[0].name,
        start: new Date(),
      };
      request(app)
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          if (err) return done(err);
          res.body._id.should.match(/[a-f\d]{24}/);
          createdBuild = res.body;
          return done();
        });
    });
  });

  describe('GET /builds for a team', () => {
    it('respond with json containing a list of all builds for the team', (done) => {
      request(app)
        .get(`${baseUrl}build?teamId=${team._id}`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          should(res.body.builds).be.an.Array();
          done();
        });
    });
  });

  describe('POST /build - negative tests', () => {
    it('respond with 422 when trying to create a build with empty body', (done) => {
      request(app)
        .post(`${baseUrl}build`)
        .send({})
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 404 when trying to create a build with non-existent team', (done) => {
      const createBuildRequest = {
        environment: 'unit-testing-environment',
        team: 'non-existent',
        name: 'unit-testing-build',
        component: '',
        start: new Date(),
      };
      request(app)
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(404, done);
    });

    it('respond with 404 when trying to create a build with non-existent environment', (done) => {
      const createBuildRequest = {
        environment: 'non-existent',
        team: 'unit-testing-team',
        name: 'unit-testing-build',
        component: '',
        start: new Date(),
      };
      request(app)
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(404, done);
    });
  });
});

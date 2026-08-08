const should = require('should');
const pino = require('pino');
const testUtils = require('./test-utils.js');
const Build = require('../app/models/build.js');
const Execution = require('../app/models/execution.js');
const Environment = require('../app/models/environment.js');
const Phase = require('../app/models/phase.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let team;
let environment;
let phase;
let createdBuild;
let buildWithExecutions;
let emptyExecutionsBuild;
let request;

describe('Build API Tests', () => {
  before((done) => {
    const clearingPromises = [
      Team.deleteMany({ name: 'build-unit-testing-team' }).exec(),
      Environment.deleteMany({ name: 'build-unit-testing-environment' }).exec(),
      Phase.deleteMany({ name: 'build-unit-testing-phase' }).exec(),
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
      phase = new Phase({
        name: 'build-unit-testing-phase',
      });
      const savePromises = [
        team.save(),
        environment.save(),
        phase.save(),
      ];
      Promise.all(savePromises).then(() => testUtils.getAdminAgent()).then((agent) => {
        request = agent;
        logger.info('Created required environment, team & phase for build tests.');
        done();
      }).catch(done);
    });
  });
  after(() => {
    // teardown
    team.remove();
    environment.remove();
    phase.remove();
    Build.findOneAndRemove({ _id: createdBuild._id }).exec();
    if (buildWithExecutions) {
      Execution.deleteMany({ build: buildWithExecutions._id }).exec();
      Build.findOneAndRemove({ _id: buildWithExecutions._id }).exec();
    }
    if (emptyExecutionsBuild) {
      Build.findOneAndRemove({ _id: emptyExecutionsBuild._id }).exec();
    }
  });

  describe('POST /build', () => {
    it('successfully create build with valid details', (done) => {
      const createBuildRequest = {
        environment: environment.name,
        team: team.name,
        phase: phase.name,
        name: 'build-unit-testing-build',
        component: team.components[0].name,
        start: new Date(),
      };
      request
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

  describe('POST /build with executions', () => {
    it('successfully create build and its executions in a single call', (done) => {
      const start = new Date();
      const end = new Date(start.getTime() + 1000);
      const createBuildRequest = {
        environment: environment.name,
        team: team.name,
        name: 'build-unit-testing-build-with-executions',
        component: team.components[0].name,
        start,
        executions: [
          {
            title: 'passing-test',
            suite: 'suite-one',
            start,
            end,
            actions: [{
              name: 'action-one',
              steps: [{
                name: 'step-one', status: 'PASS', timestamp: start,
              }],
            }],
          },
          {
            title: 'failing-test',
            suite: 'suite-one',
            start,
            end,
            actions: [{
              name: 'action-one',
              steps: [{
                name: 'step-one', status: 'FAIL', timestamp: end,
              }],
            }],
          },
          {
            title: 'another-passing-test',
            suite: 'suite-two',
            start,
            end,
            actions: [{
              name: 'action-one',
              steps: [{
                name: 'step-one', status: 'PASS', timestamp: start,
              }],
            }],
          },
        ],
      };
      request
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          if (err) return done(err);
          buildWithExecutions = res.body;
          res.body._id.should.match(/[a-f\d]{24}/);
          // executions should be grouped into suites by their suite name
          res.body.suites.should.have.length(2);
          const suiteOne = res.body.suites.find((suite) => suite.name === 'suite-one');
          const suiteTwo = res.body.suites.find((suite) => suite.name === 'suite-two');
          suiteOne.executions.should.have.length(2);
          suiteTwo.executions.should.have.length(1);
          // and the build metrics should be rolled up from them
          res.body.result.PASS.should.equal(2);
          res.body.result.FAIL.should.equal(1);
          res.body.status.should.equal('FAIL');
          return done();
        });
    });

    it('respond with 422 when an execution in the array is missing a suite', (done) => {
      const createBuildRequest = {
        environment: environment.name,
        team: team.name,
        name: 'build-unit-testing-build-invalid-executions',
        component: team.components[0].name,
        start: new Date(),
        executions: [{ title: 'no-suite-test' }],
      };
      request
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('successfully create build when executions is an empty array', (done) => {
      const createBuildRequest = {
        environment: environment.name,
        team: team.name,
        name: 'build-unit-testing-build-empty-executions',
        component: team.components[0].name,
        start: new Date(),
        executions: [],
      };
      request
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          if (err) return done(err);
          emptyExecutionsBuild = res.body;
          res.body.suites.should.have.length(0);
          return done();
        });
    });
  });

  describe('GET /builds for a team', () => {
    it('respond with json containing a list of all builds for the team', (done) => {
      request
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

  describe('GET /build/:buildId/report', () => {
    it('should retrieve the build report as HTML', (done) => {
      request
        .get(`${baseUrl}build/${createdBuild._id}/report`)
        .expect('Content-Type', /html/)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.text.should.containEql('<html>');
          res.text.should.containEql('build-unit-testing-build');
          done();
        });
    });
  });

  describe('POST /build - negative tests', () => {
    it('respond with 422 when trying to create a build with empty body', (done) => {
      request
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
      request
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
      request
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(404, done);
    });

    it('respond with 404 when trying to create a build with non-existent test phase', (done) => {
      const createBuildRequest = {
        environment: 'unit-testing-environment',
        team: 'unit-testing-team',
        name: 'unit-testing-build',
        phase: 'non-existent',
        component: '',
        start: new Date(),
      };
      request
        .post(`${baseUrl}build`)
        .send(createBuildRequest)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(404, done);
    });
  });
});

const request = require('supertest');
const should = require('should');
const pino = require('pino');
const app = require('../server.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');
const Phase = require('../app/models/phase.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let team;
let environment;
let phase;
let createdBuild;
let createdBuildWithTests;

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
      Promise.all(savePromises).then(() => {
        logger.info('Created required environment, team & phase for build tests.');
        done();
      });
    });
  });
  after(() => {
    // teardown
    team.remove();
    environment.remove();
    phase.remove();
    Build.findOneAndRemove({ _id: createdBuild._id }).exec();
    Build.findOneAndRemove({ _id: createdBuildWithTests._id }).exec();
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

    it('successfully create delayed build (containing a test) with valid details', (done) => {
      const createBuildRequest = {
        environment: environment.name,
        team: team.name,
        phase: phase.name,
        name: 'build-unit-testing-build',
        component: team.components[0].name,
        start: new Date(),
        suites: [
          {
            name: 'example suite',
            executions: [
              {
                tags: [],
                title: 'example test',
                suite: 'example suite',
                actions: [
                  {
                    name: 'Setup Steps',
                    steps: [
                      {
                        name: 'info',
                        info: 'Setting up',
                        status: 'INFO',
                        timestamp: '2022-02-05T10:20:51.688Z',
                      },
                      {
                        name: 'info',
                        info: 'Nore setup.',
                        status: 'INFO',
                        timestamp: '2022-02-05T10:20:55.786Z',
                      },
                    ],
                  },
                  {
                    name: 'Test Steps',
                    steps: [
                      {
                        name: 'Assert',
                        expected: 'value',
                        actual: 'value',
                        status: 'PASS',
                        timestamp: '2022-02-05T10:21:02.673Z',
                      },
                      {
                        name: 'info',
                        info: 'Doing some more stuff.',
                        status: 'INFO',
                        timestamp: '2022-02-05T10:21:04.449Z',
                      },
                    ],
                    status: 'PASS',
                  },
                  {
                    name: 'Teardown Steps',
                    steps: [
                      {
                        name: 'info',
                        info: 'Tearing down',
                        status: 'INFO',
                        timestamp: '2022-02-05T10:21:04.480Z',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
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
          createdBuildWithTests = res.body;
          createdBuildWithTests.suites.should.length(1);
          createdBuildWithTests.suites[0].executions.should.length(1);
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

    it('respond with 404 when trying to create a build with non-existent test phase', (done) => {
      const createBuildRequest = {
        environment: 'unit-testing-environment',
        team: 'unit-testing-team',
        name: 'unit-testing-build',
        phase: 'non-existent',
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

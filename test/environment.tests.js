const request = require('supertest');
const pino = require('pino');
const app = require('../server.js');
const Environment = require('../app/models/environment.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let environment;
let createdEnvironment;

describe('Environment API Tests', () => {
  before((done) => {
    // clear lingering test environments
    Environment.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        logger.error(err);
      } else {
        logger.info('Cleared any lingering test environments');
        // setup the test enviroment
        environment = new Environment({
          name: 'unit-testing-environment',
        });
        environment.save(() => {
          done();
        });
      }
    });
  });
  after(() => {
    environment.remove();
    Environment.findOneAndRemove({ _id: createdEnvironment._id }).exec();

  });
  describe('GET /environment', () => {
    it('respond with json containing a list of all environments', (done) => {
      request(app)
        .get(`${baseUrl}environment`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
  });

  describe('POST /environment', () => {
    it('respond with 201 when creating a valid environment', (done) => {
      request(app)
        .post(`${baseUrl}environment`)
        .send({ name: 'unit-testing-environment-new' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          createdEnvironment = res.body;
          if (err) throw err;
          done();
        });
    });
  });

  describe('POST /environment - negative tests', () => {
    it('respond with 422 when trying to create an environment with empty body', (done) => {
      request(app)
        .post(`${baseUrl}environment`)
        .send({})
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 422 when trying to create an environment with a very long name', (done) => {
      request(app)
        .post(`${baseUrl}environment`)
        .send({ name: 'unit-testing-environment-with-way-too-long-of-a-name' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 409 when trying to create an environment that already exists', (done) => {
      request(app)
        .post(`${baseUrl}environment`)
        .send({ name: environment.name })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(409, done);
    });
  });
});

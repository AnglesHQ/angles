const request = require('supertest');
const app = require('../server.js');
const Environment = require('../app/models/environment.js');

const baseUrl = '/rest/api/v1.0/';


describe('Environment API Tests', () => {
  before(() => {
    // clear lingering test environments
    Environment.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        console.log(err);
      } else {
        console.log('Cleared any lingering test environments');
      }
    });
    // setup the test enviroment
    const environment = new Environment({
      name: 'unit-testing-environment',
    });
    environment.save();
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
        .expect(201, done);
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
        .send({ name: 'unit-testing-environment' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(409, done);
    });
  });
});

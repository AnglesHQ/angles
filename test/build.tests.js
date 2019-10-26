const request = require('supertest')
const app = require('../server.js');
const baseUrl = '/rest/api/v1.0/';


describe('Build API Tests', function () {

  before(function() {
    // do the setup required for all tests
    //create test data
  });

  describe('GET /build', function () {
      it('respond with json containing a list of all builds', function (done) {
          request(app)
              .get(baseUrl + 'build')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, done);
      });
  });

  describe('POST /build - negative tests', function () {
      it('respond with 422 when trying to create a build with empty body', function (done) {
          request(app)
              .post(baseUrl + 'build')
              .send({})
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(422, done);
      });

      it('respond with 404 when trying to create a build with non-existent team', function (done) {
          request(app)
              .post(baseUrl + 'build')
              .send({team: 'non-existent', environment: 'development'})
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(404, done);
      });

      it('respond with 404 when trying to create a build with non-existent environment', function (done) {
          request(app)
              .post(baseUrl + 'build')
              .send({team: 'qa2', environment: 'non-exists'})
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(404, done);
      });
  });
});

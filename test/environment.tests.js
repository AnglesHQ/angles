const request = require('supertest')
const app = require('../server.js');
const baseUrl = '/rest/api/v1.0/';

describe('Environment API Tests', function () {

  before(function() {
    // do the setup required for all tests
    //create test data
  });

  describe('GET /environment', function () {
      it('respond with json containing a list of all environments', function (done) {
          request(app)
              .get(baseUrl + 'environment')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, done);
      });
  });

  describe('POST /environment - negative tests', function () {
      it('respond with 422 when trying to create an environment with empty body', function (done) {
          request(app)
              .post(baseUrl + 'environment')
              .send({})
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(422, done);
      });
  });

});

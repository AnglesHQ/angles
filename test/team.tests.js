const request = require('supertest')
const app = require('../server.js');
const baseUrl = '/rest/api/v1.0/';

describe('Team API Tests', function () {

  before(function() {
    // do the setup required for all tests
    //create test data
  });

  describe('GET /team', function () {
      it('respond with json containing a list of all teams', function (done) {
          request(app)
              .get(baseUrl + 'team')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, done);
      });
  });

  describe('POST /team - negative tests', function () {
      it('respond with 422 when trying to create a team with empty body', function (done) {
          request(app)
              .post(baseUrl + 'team')
              .send({})
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(422, done);
      });
  });

});

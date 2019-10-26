const request = require('supertest')
const app = require('../server.js');
const baseUrl = '/rest/api/v1.0/';
const Build = require('../app/models/build.js');
var should = require('should');

describe('Build API Tests', function () {

  before(function() {
    // do the setup required for all tests
    Build.deleteMany({environment: "unit-testing-environment"}, function(err) {
        if (err) {
          console.log(err);
        } else {
          console.log('Cleared any lingering test builds');
        }
    });
  });

  describe('GET /build', function () {
      it('respond with json containing a list of all builds', function (done) {
          request(app)
              .get(baseUrl + 'build')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, done);
      });

      //add a build and ensure it's returned in the the full list.
  });

  describe('POST /build', function () {
      it('succesfully create build with valid details', function (done) {
          var build = new Build({
            environment: 'development',
            team: 'qa2'
          });
          request(app)
              .post(baseUrl + 'build')
              .send(build)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(201)
              .end(function(err, res) {
                if (err) return done(err);
                res.body._id.should.match(/[a-f\d]{24}/);
                done();
              });
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
          var build = new Build({
            environment: 'unit-testing-environment',
            team: 'non-existent'
          });
          request(app)
              .post(baseUrl + 'build')
              .send(build)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(404, done);
      });

      it('respond with 404 when trying to create a build with non-existent environment', function (done) {
          var build = new Build({
            environment: 'non-existent',
            team: 'qa2'
          });
          request(app)
              .post(baseUrl + 'build')
              .send(build)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(404, done);
      });
  });
});

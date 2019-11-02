/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] } ] */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "should" } ] */

const request = require('supertest');
const should = require('should');
const app = require('../server.js');
const Build = require('../app/models/build.js');

const baseUrl = '/rest/api/v1.0/';

describe('Build API Tests', () => {
  before(() => {
    // do the setup required for all tests
    Build.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        console.log(err);
      } else {
        console.log('Cleared any lingering test builds');
      }
    });
  });

  describe('GET /build', () => {
    it('respond with json containing a list of all builds', (done) => {
      request(app)
        .get(`${baseUrl}build`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
    // add a build and ensure it's returned in the the full list.
  });

  describe('POST /build', () => {
    it('succesfully create build with valid details', (done) => {
      const createBuildRequest = {
        environment: 'unit-testing-environment',
        team: 'unit-testing-team',
        name: 'unit-testing-build',
        component: '',
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
          return done();
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

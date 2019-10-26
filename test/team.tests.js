const request = require('supertest')
const app = require('../server.js');
const baseUrl = '/rest/api/v1.0/';
const Team = require('../app/models/team.js');

describe('Team API Tests', function () {

  before(function() {
    //clear lingering test environments
    Team.deleteMany({name: /^unit-testing/}, function(err) {
        if (err) {
          console.log(err);
        } else {
          console.log('Cleared any lingering test teams');
        }
    });
    //setup the test enviroment
    const team = new Team({
      name: "unit-testing-team"
    });
    team.save();
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

  describe('POST /team', function () {
    it('respond with 201 when creating a valid team', function (done) {
        request(app)
            .post(baseUrl + 'team')
            .send({name: "unit-testing-team-new"})
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .expect(201, done);
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

      it('respond with 409 when trying to create an team that already exists', function (done) {
          request(app)
              .post(baseUrl + 'team')
              .send({name: "unit-testing-team"})
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(409, done);
      });
  });

});

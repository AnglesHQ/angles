const request = require('supertest');
const pino = require('pino');
const app = require('../server.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let team;
let createdTeam;


describe('Team API Tests', () => {
  before((done) => {
    // clear lingering test environments
    Team.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        logger.log('Error occured whilst clearing testing teams', err);
      } else {
        logger.info('Cleared any lingering test teams');
        // setup the test enviroment
        team = new Team({
          name: 'unit-testing-team',
          components: [{ name: 'component1' }],
        });
        team.save(() => {
          done();
        });
      }
    });
  });

  after(() => {
    // clean-up created teams
    team.remove();
    Team.findOneAndRemove({ _id: createdTeam._id }).exec();
  });

  describe('GET /team', () => {
    it('respond with json containing a list of all teams', (done) => {
      request(app)
        .get(`${baseUrl}team`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
  });

  describe('POST /team', () => {
    it('respond with 201 when creating a valid team', (done) => {
      request(app)
        .post(`${baseUrl}team`)
        .send({ name: 'unit-testing-team-new', components: [{ name: 'component' }] })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          createdTeam = res.body;
          if (err) throw err;
          done();
        });
    });

    it('respond with 201 when adding a component to an existing team', (done) => {
      request(app)
        .put(`${baseUrl}team/${team._id}/components`)
        .send({ components: ['component2'] })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
  });

  describe('POST /team - negative tests', () => {
    it('respond with 422 when trying to create a team with empty body', (done) => {
      request(app)
        .post(`${baseUrl}team`)
        .send({})
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 422 when trying to create a team with a very long name', (done) => {
      request(app)
        .post(`${baseUrl}team`)
        .send({ name: 'unit-testing-team-with-a-very-long-testing-name-123', components: [] })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 422 when trying to create a team with no components', (done) => {
      request(app)
        .post(`${baseUrl}team`)
        .send({ name: 'unit-testing-team-new', components: [] })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 409 when trying to create an team that already exists', (done) => {
      request(app)
        .post(`${baseUrl}team`)
        .send({ name: 'unit-testing-team', components: [{ name: 'component' }] })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(409, done);
    });
  });
});

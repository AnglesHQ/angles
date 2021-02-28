const request = require('supertest');
const pino = require('pino');
const app = require('../server.js');
const Phase = require('../app/models/phase.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let phase;
let createdPhase;

describe('Phase API Tests', () => {
  before((done) => {
    // clear lingering test phases
    Phase.deleteMany({ name: /^unit-testing/ }, (err) => {
      if (err) {
        logger.error(err);
      } else {
        logger.info('Cleared any lingering test phases');
        // setup the test enviroment
        phase = new Phase({
          name: 'unit-testing-phase',
          orderNumber: 300,
        });
        phase.save(() => {
          done();
        });
      }
    });
  });
  after(() => {
    phase.remove();
    Phase.findOneAndRemove({ _id: createdPhase._id }).exec();
  });
  describe('GET /phase', () => {
    it('respond with json containing a list of all phases', (done) => {
      request(app)
        .get(`${baseUrl}phase`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200, done);
    });
  });

  describe('POST /phase', () => {
    it('respond with 201 when creating a valid phase', (done) => {
      request(app)
        .post(`${baseUrl}phase`)
        .send({ name: 'unit-testing-phase-new' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          if (err) return done(err);
          res.body._id.should.match(/[a-f\d]{24}/);
          createdPhase = res.body;
          if (err) throw err;
          return done();
        });
    });
  });

  describe('POST /phase - negative tests', () => {
    it('respond with 422 when trying to create an phase with empty body', (done) => {
      request(app)
        .post(`${baseUrl}phase`)
        .send({})
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 422 when trying to create an phase with a very long name', (done) => {
      request(app)
        .post(`${baseUrl}phase`)
        .send({ name: 'unit-testing-phase-with-way-too-long-of-a-name' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(422, done);
    });

    it('respond with 409 when trying to create an phase that already exists', (done) => {
      request(app)
        .post(`${baseUrl}phase`)
        .send({ name: phase.name })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(409, done);
    });
  });
});

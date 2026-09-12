/**
 * Tests for manual test case CRUD and the immutable version history behind it.
 *
 * The versioning assertions are the important ones: a regression there is silent - nothing
 * errors, history just quietly starts showing the wrong content - so they check the frozen
 * content directly rather than only that a version number moved.
 */
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const MEMBER_PASSWORD = 'unit-testing-McMember1!';
const OUTSIDER_PASSWORD = 'unit-testing-McOutsider1!';
const LEAD_PASSWORD = 'unit-testing-McLead1!';

describe('Manual Test Case API Tests', () => {
  let adminAgent; // admin agent
  let memberAgent; // plain user in the owning team
  let outsiderAgent; // plain user in a different team
  let leadAgent; // team_lead in the owning team (may delete)
  let team;
  let otherTeam;
  let createdCase;

  const login = (username, password) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent
      .post(`${baseUrl}auth/login`)
      .send({ username, password })
      .end((err, res) => {
        if (err) return reject(err);
        if (res.status !== 200) return reject(new Error(`login failed for ${username}: ${res.status}`));
        return resolve(agent);
      });
  });

  const validCase = (overrides = {}) => ({
    team: team._id.toString(),
    title: 'unit-testing-mc login with valid credentials',
    description: 'Verifies a user can log in.',
    preconditions: 'A registered account exists.',
    priority: 'HIGH',
    tags: ['login', 'smoke'],
    steps: [
      { action: 'Navigate to the login page', expected: 'The login form is displayed' },
      { action: 'Enter valid credentials and submit', expected: 'The dashboard is displayed' },
    ],
    ...overrides,
  });

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-mc/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mc/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mc/ }).exec(),
    ]);
    logger.info('Cleared any lingering manual test case fixtures');

    team = await new Team({
      name: 'unit-testing-mc-team',
      components: [{ name: 'mc-component' }],
    }).save();
    otherTeam = await new Team({
      name: 'unit-testing-mc-other',
      components: [{ name: 'mc-other-component' }],
    }).save();

    const [memberHash, outsiderHash, leadHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10),
      bcrypt.hash(OUTSIDER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
    ]);
    await User.create([
      {
        username: 'unit-testing-mc-member', password: memberHash, role: 'user', teams: [team._id],
      },
      {
        username: 'unit-testing-mc-outsider', password: outsiderHash, role: 'user', teams: [otherTeam._id],
      },
      {
        username: 'unit-testing-mc-lead', password: leadHash, role: 'team_lead', teams: [team._id],
      },
    ]);

    [adminAgent, memberAgent, outsiderAgent, leadAgent] = await Promise.all([
      testUtils.getAdminAgent(),
      login('unit-testing-mc-member', MEMBER_PASSWORD),
      login('unit-testing-mc-outsider', OUTSIDER_PASSWORD),
      login('unit-testing-mc-lead', LEAD_PASSWORD),
    ]);
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-mc/ }).select('_id').lean();
    await Promise.all([
      ManualTestCaseVersion.deleteMany({
        testCase: { $in: cases.map((c) => c._id) },
      }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mc/ }).exec(),
      User.deleteMany({ username: /^unit-testing-mc/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mc/ }).exec(),
    ]);
  });

  describe('POST /manual-test-case', () => {
    it('respond with 201 when creating a valid test case', (done) => {
      adminAgent
        .post(`${baseUrl}manual-test-case`)
        .send(validCase())
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          if (err) throw err;
          createdCase = res.body;
          should(res.body.title).equal('unit-testing-mc login with valid credentials');
          should(res.body.status).equal('DRAFT');
          should(res.body.priority).equal('HIGH');
          should(res.body.version).equal(1);
          should(res.body.steps).have.length(2);
          done();
        });
    });

    it('assigns sequential order values to steps that omit them', (done) => {
      adminAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.steps[0].order).equal(1);
          should(res.body.steps[1].order).equal(2);
          done();
        });
    });

    it('writes an immutable version 1 alongside the case', async () => {
      const versions = await ManualTestCaseVersion
        .find({ testCase: createdCase._id })
        .lean();
      should(versions).have.length(1);
      should(versions[0].version).equal(1);
      should(versions[0].title).equal('unit-testing-mc login with valid credentials');
      should(versions[0].steps).have.length(2);
    });

    it('respond with 422 when creating a test case with an empty body', (done) => {
      adminAgent
        .post(`${baseUrl}manual-test-case`)
        .send({})
        .set('Accept', 'application/json')
        .expect(422, done);
    });

    it('respond with 422 when a step has no action', (done) => {
      adminAgent
        .post(`${baseUrl}manual-test-case`)
        .send(validCase({ steps: [{ expected: 'something happens' }] }))
        .set('Accept', 'application/json')
        .expect(422, done);
    });

    it('respond with 422 when the priority is not a known value', (done) => {
      adminAgent
        .post(`${baseUrl}manual-test-case`)
        .send(validCase({ priority: 'URGENT' }))
        .set('Accept', 'application/json')
        .expect(422, done);
    });

    it('respond with 404 when the team does not exist', (done) => {
      adminAgent
        .post(`${baseUrl}manual-test-case`)
        .send(validCase({ team: '5f7e2b9e8f1b2c0017a1b2c3' }))
        .set('Accept', 'application/json')
        .expect(404, done);
    });

    it('respond with 403 when the user has no access to the team', (done) => {
      outsiderAgent
        .post(`${baseUrl}manual-test-case`)
        .send(validCase())
        .set('Accept', 'application/json')
        .expect(403, done);
    });
  });

  describe('GET /manual-test-case', () => {
    it('respond with the team\'s test cases and a total count', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case?teamId=${team._id}`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.testCases.length).be.above(0);
          should(res.body.metrics.totalTestCases).be.above(0);
          done();
        });
    });

    it('filters by status', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case?teamId=${team._id}&status=ACTIVE`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          res.body.testCases.forEach((testCase) => should(testCase.status).equal('ACTIVE'));
          done();
        });
    });

    it('filters by search term', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case?teamId=${team._id}&search=valid credentials`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.testCases.length).be.above(0);
          done();
        });
    });

    it('treats a regex metacharacter in the search term as a literal', (done) => {
      // An unescaped "(a+)+$" would be evaluated as a pattern by the database.
      memberAgent
        .get(`${baseUrl}manual-test-case?teamId=${team._id}&search=${encodeURIComponent('(a+)+$')}`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.testCases).have.length(0);
          done();
        });
    });

    it('respond with 403 when the user has no access to the team', (done) => {
      outsiderAgent
        .get(`${baseUrl}manual-test-case?teamId=${team._id}`)
        .set('Accept', 'application/json')
        .expect(403, done);
    });

    it('respond with 422 when teamId is missing', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case`)
        .set('Accept', 'application/json')
        .expect(422, done);
    });
  });

  describe('GET /manual-test-case/:caseId', () => {
    it('respond with the test case', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body._id).equal(createdCase._id);
          done();
        });
    });

    it('respond with 403 for a user outside the owning team', (done) => {
      outsiderAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}`)
        .set('Accept', 'application/json')
        .expect(403, done);
    });

    it('respond with 404 for an unknown id', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case/5f7e2b9e8f1b2c0017a1b2c3`)
        .set('Accept', 'application/json')
        .expect(404, done);
    });
  });

  describe('PUT /manual-test-case/:caseId', () => {
    it('bumps the version and freezes a new one when content changes', (done) => {
      memberAgent
        .put(`${baseUrl}manual-test-case/${createdCase._id}`)
        .send({ title: 'unit-testing-mc login with valid credentials v2' })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.version).equal(2);
          should(res.body.title).equal('unit-testing-mc login with valid credentials v2');
          done();
        });
    });

    it('leaves version 1 showing the original content', async () => {
      const version1 = await ManualTestCaseVersion
        .findOne({ testCase: createdCase._id, version: 1 })
        .lean();
      should(version1.title).equal('unit-testing-mc login with valid credentials');
    });

    it('does not bump the version when nothing changed', (done) => {
      memberAgent
        .put(`${baseUrl}manual-test-case/${createdCase._id}`)
        .send({ title: 'unit-testing-mc login with valid credentials v2' })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.version).equal(2);
          done();
        });
    });

    it('does not bump the version for a status-only change', (done) => {
      memberAgent
        .put(`${baseUrl}manual-test-case/${createdCase._id}`)
        .send({ status: 'ACTIVE' })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.status).equal('ACTIVE');
          should(res.body.version).equal(2);
          done();
        });
    });

    it('bumps the version when steps change', (done) => {
      memberAgent
        .put(`${baseUrl}manual-test-case/${createdCase._id}`)
        .send({
          steps: [
            { action: 'Navigate to the login page', expected: 'The login form is displayed' },
            { action: 'Enter valid credentials and submit', expected: 'The dashboard is displayed' },
            { action: 'Log out', expected: 'The login form is displayed again' },
          ],
        })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.version).equal(3);
          should(res.body.steps).have.length(3);
          done();
        });
    });

    it('leaves the earlier versions\' steps untouched', async () => {
      const versions = await ManualTestCaseVersion
        .find({ testCase: createdCase._id })
        .sort('version')
        .lean();
      should(versions).have.length(3);
      should(versions[0].steps).have.length(2);
      should(versions[1].steps).have.length(2);
      should(versions[2].steps).have.length(3);
    });

    it('respond with 403 for a user outside the owning team', (done) => {
      outsiderAgent
        .put(`${baseUrl}manual-test-case/${createdCase._id}`)
        .send({ title: 'unit-testing-mc hijacked' })
        .set('Accept', 'application/json')
        .expect(403, done);
    });
  });

  describe('GET /manual-test-case/:caseId/version', () => {
    it('lists every version, newest first', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}/version`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.versions).have.length(3);
          should(res.body.versions[0].version).equal(3);
          done();
        });
    });

    it('serves the frozen content of a specific version', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}/version/1`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.version).equal(1);
          should(res.body.title).equal('unit-testing-mc login with valid credentials');
          should(res.body.steps).have.length(2);
          done();
        });
    });

    it('respond with 404 for a version that does not exist', (done) => {
      memberAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}/version/99`)
        .set('Accept', 'application/json')
        .expect(404, done);
    });

    it('respond with 403 for a user outside the owning team', (done) => {
      outsiderAgent
        .get(`${baseUrl}manual-test-case/${createdCase._id}/version/1`)
        .set('Accept', 'application/json')
        .expect(403, done);
    });
  });

  describe('POST /manual-test-case/:caseId/clone', () => {
    let clonedCase;

    it('clones a test case as a new draft starting at version 1', (done) => {
      memberAgent
        .post(`${baseUrl}manual-test-case/${createdCase._id}/clone`)
        .send({ title: 'unit-testing-mc cloned case' })
        .set('Accept', 'application/json')
        .expect(201)
        .end((err, res) => {
          if (err) throw err;
          clonedCase = res.body;
          should(res.body.title).equal('unit-testing-mc cloned case');
          should(res.body.status).equal('DRAFT');
          should(res.body.version).equal(1);
          should(res.body.steps).have.length(3);
          should(res.body._id).not.equal(createdCase._id);
          done();
        });
    });

    it('gives the clone its own version history', async () => {
      const versions = await ManualTestCaseVersion
        .find({ testCase: clonedCase._id })
        .lean();
      should(versions).have.length(1);
      should(versions[0].version).equal(1);
    });

    it('defaults the title when none is supplied', (done) => {
      memberAgent
        .post(`${baseUrl}manual-test-case/${createdCase._id}/clone`)
        .send({})
        .set('Accept', 'application/json')
        .expect(201)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.title).endWith('(copy)');
          done();
        });
    });
  });

  describe('DELETE /manual-test-case/:caseId', () => {
    let deletableCase;

    beforeEach((done) => {
      leadAgent
        .post(`${baseUrl}manual-test-case`)
        .send(validCase({ title: 'unit-testing-mc deletable case' }))
        .set('Accept', 'application/json')
        .expect(201)
        .end((err, res) => {
          if (err) throw err;
          deletableCase = res.body;
          done();
        });
    });

    it('respond with 403 when a plain team member tries to delete', (done) => {
      memberAgent
        .delete(`${baseUrl}manual-test-case/${deletableCase._id}`)
        .set('Accept', 'application/json')
        .expect(403, done);
    });

    it('respond with 403 for a user outside the owning team', (done) => {
      outsiderAgent
        .delete(`${baseUrl}manual-test-case/${deletableCase._id}`)
        .set('Accept', 'application/json')
        .expect(403, done);
    });

    it('respond with 200 when a team lead deletes, removing its versions', async () => {
      await new Promise((resolve, reject) => {
        leadAgent
          .delete(`${baseUrl}manual-test-case/${deletableCase._id}`)
          .set('Accept', 'application/json')
          .expect(200)
          .end((err) => (err ? reject(err) : resolve()));
      });
      const versions = await ManualTestCaseVersion
        .countDocuments({ testCase: deletableCase._id });
      should(versions).equal(0);
    });

    it('respond with 404 for an unknown id', (done) => {
      leadAgent
        .delete(`${baseUrl}manual-test-case/5f7e2b9e8f1b2c0017a1b2c3`)
        .set('Accept', 'application/json')
        .expect(404, done);
    });
  });
});

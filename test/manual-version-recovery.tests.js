/**
 * Regression tests for the version/head write ordering.
 *
 * The head and its frozen versions are two separate writes. If a version lands and the head
 * save then fails, the head sits one version behind what is on disk - and because
 * { testCase, version } is unique, every later edit retries that same number and fails with
 * a duplicate key error. The case is then permanently unsaveable.
 *
 * That is exactly what a shared step inclusion used to trigger: the version stores expanded
 * steps (which have an action) while the head stores the placeholder (which does not), so
 * the version validated and the head did not.
 */
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const SharedStep = require('../app/models/shared-step.js');
const { Team } = require('../app/models/team.js');

const baseUrl = '/rest/api/v1.0/';
const LEAD_PASSWORD = 'unit-testing-MvrLead1!';

describe('Manual Test Case Version Recovery Tests', () => {
  let leadAgent;
  let team;
  let sharedStep;

  const login = (username, password) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent
      .post(`${baseUrl}auth/login`)
      .send({ username, password })
      .end((err, res) => {
        if (err) return reject(err);
        if (res.status !== 200) return reject(new Error(`login failed: ${res.status}`));
        return resolve(agent);
      });
  });

  const send = (agent, method, url, body) => new Promise((resolve, reject) => {
    const req = agent[method](`${baseUrl}${url}`).set('Accept', 'application/json');
    if (body !== undefined) req.send(body);
    req.end((err, res) => (err ? reject(err) : resolve(res)));
  });

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-mvr/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mvr/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mvr/ }).exec(),
      SharedStep.deleteMany({ name: /^unit-testing-mvr/ }).exec(),
    ]);

    team = await new Team({ name: 'unit-testing-mvr-team', components: [{ name: 'mvr-component' }] }).save();
    const hash = await bcrypt.hash(LEAD_PASSWORD, 10);
    await User.create({
      username: 'unit-testing-mvr-lead', password: hash, role: 'team_lead', teams: [team._id],
    });
    leadAgent = await login('unit-testing-mvr-lead', LEAD_PASSWORD);

    const created = await send(leadAgent, 'post', 'shared-step', {
      team: team._id.toString(),
      name: 'unit-testing-mvr shared',
      steps: [{ action: 'Log in', expected: 'Logged in' }],
    });
    sharedStep = created.body;
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-mvr/ }).select('_id').lean();
    await Promise.all([
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mvr/ }).exec(),
      SharedStep.deleteMany({ name: /^unit-testing-mvr/ }).exec(),
      User.deleteMany({ username: /^unit-testing-mvr/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mvr/ }).exec(),
    ]);
  });

  describe('a shared step inclusion carries no action of its own', () => {
    let caseId;

    it('accepts a step that only references a shared step', async () => {
      const res = await send(leadAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-mvr inclusion',
        steps: [{ sharedStep: sharedStep._id }],
      });
      should(res.status).equal(201);
      caseId = res.body._id;
    });

    it('saves an update that adds an inclusion without an action', async () => {
      // The exact shape the UI sends: an inclusion plus a literal step.
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        steps: [
          { sharedStep: sharedStep._id },
          { action: 'Press spin', expected: 'Reels spin' },
        ],
      });
      should(res.status).equal(200);
      should(res.body.version).equal(2);
    });

    it('leaves the head and the versions in step', async () => {
      const head = await ManualTestCase.findById(caseId).lean();
      const latest = await ManualTestCaseVersion
        .findOne({ testCase: caseId }).sort('-version').lean();
      should(head.version).equal(latest.version);
    });

    it('saves again rather than colliding on the version index', async () => {
      // This is the failure the user hit: the second edit after an inclusion was added.
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        steps: [
          { sharedStep: sharedStep._id },
          { action: 'Press spin', expected: 'Reels spin' },
          { action: 'Increase coin size', expected: 'Stake rises' },
        ],
      });
      should(res.status).equal(200);
      should(res.body.version).equal(3);
    });

    it('accepts expanded steps echoed back by a client', async () => {
      // A client that read the case holds *expanded* steps - they carry sharedStepRef
      // rather than sharedStep, and their action is whatever the shared step said, which
      // may be empty. Saving that back must not be rejected.
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        steps: [
          {
            order: 1, action: 'Log in', expected: 'Logged in', sharedStepRef: sharedStep._id, sharedStepVersion: 1,
          },
          { order: 2, action: 'Press spin', expected: 'Reels spin' },
        ],
      });
      should(res.status).equal(200);
    });

    it('accepts an expanded step whose source had no action', async () => {
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        steps: [
          {
            order: 1, expected: 'Something', sharedStepRef: sharedStep._id, sharedStepVersion: 1,
          },
          { order: 2, action: 'Press spin' },
        ],
      });
      should(res.status).equal(200);
    });

    it('still requires an action on a literal step', async () => {
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        steps: [{ expected: 'Something happens' }],
      });
      should(res.status).equal(422);
    });
  });

  describe('recovering a case whose head fell behind its versions', () => {
    let caseId;

    before(async () => {
      const created = await send(leadAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-mvr drifted',
        steps: [{ action: 'Step one' }],
      });
      caseId = created.body._id;

      // Reproduce the wedged state directly: a version at v2 with the head still at v1,
      // which is what a version write followed by a failed head save leaves behind.
      const head = await ManualTestCase.findById(caseId).lean();
      await ManualTestCaseVersion.create({
        testCase: caseId,
        version: 2,
        team: head.team,
        title: head.title,
        steps: [{ order: 1, action: 'Orphaned' }],
        createdBy: head.createdBy,
      });
    });

    it('starts from the broken state the bug produced', async () => {
      const head = await ManualTestCase.findById(caseId).lean();
      const latest = await ManualTestCaseVersion
        .findOne({ testCase: caseId }).sort('-version').lean();
      should(head.version).equal(1);
      should(latest.version).equal(2);
    });

    it('saves instead of failing with a duplicate key error', async () => {
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        title: 'unit-testing-mvr drifted, edited',
      });
      should(res.status).equal(200);
      // Skips past the orphan rather than colliding with it.
      should(res.body.version).equal(3);
    });

    it('leaves the head and the versions in step afterwards', async () => {
      const head = await ManualTestCase.findById(caseId).lean();
      const latest = await ManualTestCaseVersion
        .findOne({ testCase: caseId }).sort('-version').lean();
      should(head.version).equal(latest.version);
      should(head.version).equal(3);
    });
  });

  describe('a failed head save leaves no orphan version', () => {
    it('writes nothing when the update is invalid', async () => {
      const created = await send(leadAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-mvr atomic',
        steps: [{ action: 'Step one' }],
      });
      const caseId = created.body._id;
      const before = await ManualTestCaseVersion.countDocuments({ testCase: caseId });

      // Long enough to fail the schema's maxlength, after the content-changed check.
      const res = await send(leadAgent, 'put', `manual-test-case/${caseId}`, {
        title: 'x'.repeat(500),
      });
      should(res.status).be.aboveOrEqual(400);

      const after = await ManualTestCaseVersion.countDocuments({ testCase: caseId });
      should(after).equal(before);
      const head = await ManualTestCase.findById(caseId).lean();
      should(head.version).equal(1);
    });
  });
});

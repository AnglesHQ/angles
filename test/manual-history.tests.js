/**
 * Tests for the manual test case change history.
 *
 * History is an audit trail, distinct from the version collection: a version is the
 * content a tester saw, while a history entry says who changed what and why. The
 * interesting cases are the ones the version collection cannot express - a status change
 * that burns no version, and a case re-versioned by somebody else's shared step edit.
 */
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const ManualChangeHistory = require('../app/models/manual-change-history.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const CustomFieldDefinition = require('../app/models/custom-field-definition.js');
const SharedStep = require('../app/models/shared-step.js');
const historyUtils = require('../app/utils/history-utils.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const MEMBER_PASSWORD = 'unit-testing-HiMember1!';
const LEAD_PASSWORD = 'unit-testing-HiLead1!';
const OUTSIDER_PASSWORD = 'unit-testing-HiOutsider1!';

// History is written without being awaited, so a read immediately after a mutation can
// race it. Polls briefly rather than sleeping a fixed amount.
const waitForHistory = async (entityId, expected, attempts = 40) => {
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const count = await ManualChangeHistory.countDocuments({ entityId });
    if (count >= expected) return count;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return ManualChangeHistory.countDocuments({ entityId });
};

describe('Manual Change History Tests', () => {
  let adminAgent;
  let memberAgent;
  let leadAgent;
  let outsiderAgent;
  let team;
  let otherTeam;
  let memberUser;

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

  const send = (agent, method, url, body) => new Promise((resolve, reject) => {
    const req = agent[method](`${baseUrl}${url}`).set('Accept', 'application/json');
    if (body !== undefined) req.send(body);
    req.end((err, res) => (err ? reject(err) : resolve(res)));
  });

  const createCase = (body) => send(memberAgent, 'post', 'manual-test-case', {
    team: team._id.toString(),
    title: 'unit-testing-hi case',
    steps: [{ action: 'Step one', expected: 'It works' }],
    ...body,
  });

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-hi/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-hi/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-hi/ }).exec(),
    ]);
    logger.info('Cleared any lingering history fixtures');

    team = await new Team({ name: 'unit-testing-hi-team', components: [{ name: 'hi-component' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-hi-other', components: [{ name: 'hi-other' }] }).save();

    const [memberHash, leadHash, outsiderHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
      bcrypt.hash(OUTSIDER_PASSWORD, 10),
    ]);
    const users = await User.create([
      {
        username: 'unit-testing-hi-member', password: memberHash, role: 'user', teams: [team._id],
      },
      {
        username: 'unit-testing-hi-lead', password: leadHash, role: 'team_lead', teams: [team._id],
      },
      {
        username: 'unit-testing-hi-outsider', password: outsiderHash, role: 'user', teams: [otherTeam._id],
      },
    ]);
    [memberUser] = users;

    [adminAgent, memberAgent, leadAgent, outsiderAgent] = await Promise.all([
      testUtils.getAdminAgent(),
      login('unit-testing-hi-member', MEMBER_PASSWORD),
      login('unit-testing-hi-lead', LEAD_PASSWORD),
      login('unit-testing-hi-outsider', OUTSIDER_PASSWORD),
    ]);
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-hi/ }).select('_id').lean();
    await Promise.all([
      ManualChangeHistory.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-hi/ }).exec(),
      SharedStep.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      CustomFieldDefinition.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      User.deleteMany({ username: /^unit-testing-hi/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-hi/ }).exec(),
    ]);
  });

  describe('diffDocuments', () => {
    it('reports a scalar change as one entry', () => {
      const changes = historyUtils.diffDocuments(
        { title: 'before' },
        { title: 'after' },
        ['title'],
      );
      should(changes).have.length(1);
      should(changes[0]).eql({ field: 'title', from: 'before', to: 'after' });
    });

    it('ignores fields absent from both sides', () => {
      const changes = historyUtils.diffDocuments({}, {}, ['title', 'priority']);
      should(changes).have.length(0);
    });

    it('breaks a steps change down per position rather than one blob', () => {
      const changes = historyUtils.diffDocuments(
        { steps: [{ action: 'a' }, { action: 'b' }] },
        { steps: [{ action: 'a' }, { action: 'CHANGED' }] },
        ['steps'],
      );
      should(changes).have.length(1);
      should(changes[0].field).equal('steps[1]');
      should(changes[0].from.action).equal('b');
      should(changes[0].to.action).equal('CHANGED');
    });

    it('reports an added step', () => {
      const changes = historyUtils.diffDocuments(
        { steps: [{ action: 'a' }] },
        { steps: [{ action: 'a' }, { action: 'new' }] },
        ['steps'],
      );
      should(changes).have.length(1);
      should(changes[0].field).equal('steps[1]');
      should(changes[0].from).equal(null);
      should(changes[0].to.action).equal('new');
    });

    it('breaks a customFields change down per key', () => {
      const changes = historyUtils.diffDocuments(
        { customFields: { a: 1, b: 2 } },
        { customFields: { a: 1, b: 99 } },
        ['customFields'],
      );
      should(changes).have.length(1);
      should(changes[0].field).equal('customFields.b');
      should(changes[0].from).equal(2);
      should(changes[0].to).equal(99);
    });

    it('does not report a step that only differs by an empty attachments array', () => {
      // The same normalisation the version comparison relies on.
      const changes = historyUtils.diffDocuments(
        { steps: [{ action: 'a', attachments: [] }] },
        { steps: [{ action: 'a' }] },
        ['steps'],
      );
      should(changes).have.length(0);
    });
  });

  describe('test case history', () => {
    let testCase;

    it('records a CREATE entry naming the author', async () => {
      const res = await createCase({ title: 'unit-testing-hi tracked case' });
      should(res.status).equal(201);
      testCase = res.body;

      await waitForHistory(testCase._id, 1);
      const history = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history`);
      should(history.status).equal(200);
      should(history.body.history).have.length(1);
      should(history.body.history[0].action).equal('CREATE');
      should(history.body.history[0].version).equal(1);
      should(history.body.history[0].changedBy.username).equal('unit-testing-hi-member');
    });

    it('never exposes the user document beyond the username', async () => {
      const history = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history`);
      const [entry] = history.body.history;
      should(entry.changedBy.apiTokens).equal(undefined);
      should(entry.changedBy.password).equal(undefined);
      should(Object.keys(entry.changedBy).sort()).eql(['_id', 'username']);
    });

    it('records an UPDATE with the field-level changes', async () => {
      const res = await send(memberAgent, 'put', `manual-test-case/${testCase._id}`, {
        title: 'unit-testing-hi tracked case renamed',
        priority: 'CRITICAL',
        comment: 'Sharpened the title',
      });
      should(res.status).equal(200);

      await waitForHistory(testCase._id, 2);
      const history = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history`);
      const [entry] = history.body.history;
      should(entry.action).equal('UPDATE');
      should(entry.version).equal(2);
      should(entry.comment).equal('Sharpened the title');
      const fields = entry.changes.map((change) => change.field).sort();
      should(fields).eql(['priority', 'title']);
    });

    it('records a STATUS_CHANGE that burns no version', async () => {
      const before = await ManualTestCase.findById(testCase._id).lean();
      const res = await send(memberAgent, 'put', `manual-test-case/${testCase._id}`, {
        status: 'ACTIVE',
      });
      should(res.status).equal(200);
      // The version is deliberately unchanged - this is exactly what the version
      // collection cannot record, and why history exists alongside it.
      should(res.body.version).equal(before.version);

      await waitForHistory(testCase._id, 3);
      const history = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history`);
      const [entry] = history.body.history;
      should(entry.action).equal('STATUS_CHANGE');
      should(entry.changes).have.length(1);
      should(entry.changes[0].field).equal('status');
      should(entry.changes[0].from).equal('DRAFT');
      should(entry.changes[0].to).equal('ACTIVE');
    });

    it('writes nothing for an update that changes nothing', async () => {
      const before = await ManualChangeHistory.countDocuments({ entityId: testCase._id });
      const res = await send(memberAgent, 'put', `manual-test-case/${testCase._id}`, {
        title: 'unit-testing-hi tracked case renamed',
      });
      should(res.status).equal(200);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      should(await ManualChangeHistory.countDocuments({ entityId: testCase._id })).equal(before);
    });

    it('records step changes per position', async () => {
      const res = await send(memberAgent, 'put', `manual-test-case/${testCase._id}`, {
        steps: [
          { action: 'Step one', expected: 'It works' },
          { action: 'Step two', expected: 'Also works' },
        ],
      });
      should(res.status).equal(200);

      const history = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history`);
      const [entry] = history.body.history;
      should(entry.action).equal('UPDATE');
      should(entry.changes[0].field).equal('steps[1]');
      should(entry.changes[0].to.action).equal('Step two');
    });

    it('records a CLONE against the new case', async () => {
      const res = await send(memberAgent, 'post', `manual-test-case/${testCase._id}/clone`, {
        title: 'unit-testing-hi cloned',
      });
      should(res.status).equal(201);

      await waitForHistory(res.body._id, 1);
      const history = await send(memberAgent, 'get', `manual-test-case/${res.body._id}/history`);
      should(history.body.history).have.length(1);
      should(history.body.history[0].action).equal('CLONE');
      should(history.body.history[0].comment).match(new RegExp(testCase._id));
    });

    it('paginates, newest first', async () => {
      const history = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history?limit=2`);
      should(history.body.history).have.length(2);
      should(history.body.metrics.totalEntries).be.above(2);
      const [first, second] = history.body.history;
      should(new Date(first.changedAt) >= new Date(second.changedAt)).equal(true);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await send(outsiderAgent, 'get', `manual-test-case/${testCase._id}/history`);
      should(res.status).equal(403);
    });

    it('respond with 404 for an unknown case', async () => {
      const res = await send(memberAgent, 'get', 'manual-test-case/5f7e2b9e8f1b2c0017a1b2c3/history');
      should(res.status).equal(404);
    });

    it('records a DELETE that outlives the case', async () => {
      const created = await createCase({ title: 'unit-testing-hi doomed' });
      const doomed = created.body;

      const deleted = await send(leadAgent, 'delete', `manual-test-case/${doomed._id}`);
      should(deleted.status).equal(200);

      await waitForHistory(doomed._id, 2);
      // The case is gone, so the entry is read directly - "what happened to that test
      // case?" is only answerable because the deletion itself was logged.
      const entries = await ManualChangeHistory
        .find({ entityId: doomed._id })
        .sort('-changedAt')
        .lean();
      should(entries[0].action).equal('DELETE');
      should(entries[0].comment).match(/unit-testing-hi doomed/);
    });
  });

  describe('shared step history', () => {
    let sharedStep;
    let referencingCase;

    before(async () => {
      const created = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-hi login',
        steps: [{ action: 'Log in', expected: 'Dashboard shown' }],
      });
      sharedStep = created.body;

      const caseRes = await createCase({
        title: 'unit-testing-hi case including shared step',
        steps: [{ sharedStep: sharedStep._id, action: 'placeholder' }],
      });
      referencingCase = caseRes.body;
    });

    it('records a CREATE for the shared step', async () => {
      await waitForHistory(sharedStep._id, 1);
      const history = await send(leadAgent, 'get', `shared-step/${sharedStep._id}/history`);
      should(history.status).equal(200);
      should(history.body.history[0].action).equal('CREATE');
      should(history.body.history[0].changedBy.username).equal('unit-testing-hi-lead');
    });

    it('records an UPDATE on the shared step itself', async () => {
      const res = await send(leadAgent, 'put', `shared-step/${sharedStep._id}`, {
        steps: [
          { action: 'Log in', expected: 'Dashboard shown' },
          { action: 'Dismiss the banner', expected: 'Banner gone' },
        ],
        comment: 'Cookie banner appeared',
      });
      should(res.status).equal(200);

      await waitForHistory(sharedStep._id, 2);
      const history = await send(leadAgent, 'get', `shared-step/${sharedStep._id}/history`);
      const [entry] = history.body.history;
      should(entry.action).equal('UPDATE');
      should(entry.version).equal(2);
      should(entry.comment).equal('Cookie banner appeared');
      should(entry.changes[0].field).equal('steps[1]');
    });

    it('records SHARED_STEP_UPDATE against each cascaded case, naming the cause', async () => {
      await waitForHistory(referencingCase._id, 2);
      const history = await send(memberAgent, 'get', `manual-test-case/${referencingCase._id}/history`);
      const [entry] = history.body.history;
      // Nobody edited this case directly - without the entry its version bump would be
      // entirely unexplained.
      should(entry.action).equal('SHARED_STEP_UPDATE');
      should(entry.version).equal(2);
      should(entry.causedBy.name).equal('unit-testing-hi login');
      should(entry.comment).match(/shared step "unit-testing-hi login" was updated to v2/);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await send(outsiderAgent, 'get', `shared-step/${sharedStep._id}/history`);
      should(res.status).equal(403);
    });
  });

  describe('custom field history', () => {
    let field;

    it('records a CREATE', async () => {
      const res = await send(adminAgent, 'post', 'custom-field', {
        team: team._id.toString(),
        key: 'hi_reference',
        label: 'Reference',
        type: 'text',
      });
      should(res.status).equal(201);
      field = res.body;

      await waitForHistory(field._id, 1);
      const entries = await ManualChangeHistory.find({ entityId: field._id }).lean();
      should(entries[0].action).equal('CREATE');
      should(entries[0].entityType).equal('customfield');
    });

    it('records an UPDATE when the label changes', async () => {
      const res = await send(adminAgent, 'put', `custom-field/${field._id}`, {
        label: 'Ticket Reference',
      });
      should(res.status).equal(200);

      await waitForHistory(field._id, 2);
      const entries = await ManualChangeHistory
        .find({ entityId: field._id })
        .sort('-changedAt')
        .lean();
      should(entries[0].action).equal('UPDATE');
      should(entries[0].changes[0].field).equal('label');
      should(entries[0].changes[0].from).equal('Reference');
      should(entries[0].changes[0].to).equal('Ticket Reference');
    });

    it('records an ARCHIVE rather than a DELETE for a field in use', async () => {
      const used = await createCase({
        title: 'unit-testing-hi case using the field',
        customFields: { hi_reference: 'JIRA-1' },
      });
      should(used.status).equal(201);

      const res = await send(adminAgent, 'delete', `custom-field/${field._id}`);
      should(res.status).equal(200);
      should(res.body.archived).equal(true);

      await waitForHistory(field._id, 3);
      const entries = await ManualChangeHistory
        .find({ entityId: field._id })
        .sort('-changedAt')
        .lean();
      should(entries[0].action).equal('ARCHIVE');
      should(entries[0].comment).match(/in use by/);
    });

    it('records a DELETE for a field that was never used', async () => {
      const created = await send(adminAgent, 'post', 'custom-field', {
        team: team._id.toString(),
        key: 'hi_unused',
        label: 'Unused',
        type: 'text',
      });
      should(created.status).equal(201);

      const res = await send(adminAgent, 'delete', `custom-field/${created.body._id}`);
      should(res.status).equal(200);
      should(res.body.archived).equal(false);

      await waitForHistory(created.body._id, 2);
      const entries = await ManualChangeHistory
        .find({ entityId: created.body._id })
        .sort('-changedAt')
        .lean();
      should(entries[0].action).equal('DELETE');
    });
  });

  describe('history write failures do not fail the request', () => {
    it('still saves the case when the history write throws', async () => {
      const original = ManualChangeHistory.prototype.save;
      ManualChangeHistory.prototype.save = () => Promise.reject(new Error('history is down'));
      try {
        const res = await createCase({ title: 'unit-testing-hi history down' });
        // The change is what the user asked for; the audit line is not worth failing it.
        should(res.status).equal(201);
        const saved = await ManualTestCase.findById(res.body._id).lean();
        should(saved.title).equal('unit-testing-hi history down');
      } finally {
        ManualChangeHistory.prototype.save = original;
      }
    });
  });

  describe('history is scoped to its team', () => {
    it('does not return another team\'s entries', async () => {
      const mine = await ManualChangeHistory.countDocuments({ team: team._id });
      const theirs = await ManualChangeHistory.countDocuments({ team: otherTeam._id });
      should(mine).be.above(0);
      should(theirs).equal(0);
      should(memberUser.teams[0].toString()).equal(team._id.toString());
    });
  });
});

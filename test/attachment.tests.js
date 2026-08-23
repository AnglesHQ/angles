/**
 * Tests for manual test step attachments.
 *
 * The load-bearing behaviour is the immutability rule: once a frozen version references an
 * attachment, the file is the only copy of what that version's tester saw, so it cannot be
 * deleted while the version stands. Deleting the whole test case removes the versions
 * first, which releases the attachments.
 */
const fs = require('fs');
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const Attachment = require('../app/models/attachment.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const SharedStep = require('../app/models/shared-step.js');
const { Team } = require('../app/models/team.js');
const attachmentUtils = require('../app/utils/attachment-utils.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
const IMAGE = './test/resources/angles_home_page.jpg';

const MEMBER_PASSWORD = 'unit-testing-AtMember1!';
const LEAD_PASSWORD = 'unit-testing-AtLead1!';
const OUTSIDER_PASSWORD = 'unit-testing-AtOutsider1!';

describe('Attachment API Tests', () => {
  let memberAgent;
  let leadAgent;
  let outsiderAgent;
  let team;
  let otherTeam;
  let testCase;

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

  const upload = (agent, fields, file = IMAGE) => new Promise((resolve, reject) => {
    const req = agent.post(`${baseUrl}attachment`);
    Object.entries(fields).forEach(([key, value]) => req.field(key, value));
    if (file) req.attach('attachment', file);
    req.end((err, res) => (err ? reject(err) : resolve(res)));
  });

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-at/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-at/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-at/ }).exec(),
    ]);
    logger.info('Cleared any lingering attachment fixtures');

    team = await new Team({ name: 'unit-testing-at-team', components: [{ name: 'at-component' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-at-other', components: [{ name: 'at-other' }] }).save();

    const [memberHash, leadHash, outsiderHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
      bcrypt.hash(OUTSIDER_PASSWORD, 10),
    ]);
    await User.create([
      {
        username: 'unit-testing-at-member', password: memberHash, role: 'user', teams: [team._id],
      },
      {
        username: 'unit-testing-at-lead', password: leadHash, role: 'team_lead', teams: [team._id],
      },
      {
        username: 'unit-testing-at-outsider', password: outsiderHash, role: 'user', teams: [otherTeam._id],
      },
    ]);

    [memberAgent, leadAgent, outsiderAgent] = await Promise.all([
      login('unit-testing-at-member', MEMBER_PASSWORD),
      login('unit-testing-at-lead', LEAD_PASSWORD),
      login('unit-testing-at-outsider', OUTSIDER_PASSWORD),
    ]);
    await testUtils.getAdminAgent();

    const created = await send(memberAgent, 'post', 'manual-test-case', {
      team: team._id.toString(),
      title: 'unit-testing-at host case',
      steps: [{ action: 'Do the thing', expected: 'It happened' }],
    });
    testCase = created.body;
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-at/ }).select('_id').lean();
    const caseIds = cases.map((c) => c._id);
    // Remove the files as well as the documents - deleting the documents directly bypasses
    // the controller's cleanup and would leave the uploads behind on disk.
    const attachments = await Attachment
      .find({ team: { $in: [team._id, otherTeam._id] } })
      .lean();
    await Promise.all(attachments.map((attachment) => attachmentUtils.removeFiles(attachment)));
    const owners = new Set(attachments
      .map((attachment) => (attachment.testCase || attachment.sharedStep || '').toString())
      .filter(Boolean));
    await Promise.all([...owners]
      .map((ownerId) => attachmentUtils.removeAttachmentDirectory(ownerId)));
    await Promise.all([
      ManualTestCaseVersion.deleteMany({ testCase: { $in: caseIds } }).exec(),
      Attachment.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-at/ }).exec(),
      SharedStep.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      User.deleteMany({ username: /^unit-testing-at/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-at/ }).exec(),
    ]);
  });

  describe('POST /attachment', () => {
    let uploaded;

    it('respond with 201 when uploading an image to a test case', async () => {
      const res = await upload(memberAgent, { testCaseId: testCase._id });
      should(res.status).equal(201);
      uploaded = res.body;
      should(res.body.scope).equal('testcase');
      should(res.body.testCase).equal(testCase._id);
      should(res.body.team).equal(team._id.toString());
      should(res.body.mimeType).equal('image/jpeg');
      should(res.body.size).be.above(0);
    });

    it('writes the file and a thumbnail to disk', () => {
      should(fs.existsSync(uploaded.path)).equal(true);
      should(uploaded.thumbnail).not.equal(undefined);
      should(fs.existsSync(uploaded.thumbnail)).equal(true);
      should(uploaded.width).be.above(0);
      should(uploaded.height).be.above(0);
    });

    it('stores the file under the owning entity, with a generated name', () => {
      should(uploaded.path).match(new RegExp(`attachments/${testCase._id}/`));
      // The client filename is never used to build the path.
      should(uploaded.path).not.match(/angles_home_page/);
      should(uploaded.originalName).equal('angles_home_page.jpg');
    });

    it('serves the original file', (done) => {
      memberAgent
        .get(`${baseUrl}attachment/${uploaded._id}/file`)
        .expect(200)
        .expect('Content-Type', /image/, done);
    });

    it('serves the thumbnail', (done) => {
      memberAgent
        .get(`${baseUrl}attachment/${uploaded._id}/thumbnail`)
        .expect(200)
        .expect('Content-Type', /image/, done);
    });

    it('respond with 403 for a user outside the owning team', async () => {
      const res = await send(outsiderAgent, 'get', `attachment/${uploaded._id}`);
      should(res.status).equal(403);
    });

    it('respond with 403 when uploading to another team\'s test case', async () => {
      const res = await upload(outsiderAgent, { testCaseId: testCase._id });
      should(res.status).equal(403);
    });

    it('respond with 404 when the test case does not exist', async () => {
      const res = await upload(memberAgent, { testCaseId: '5f7e2b9e8f1b2c0017a1b2c3' });
      should(res.status).equal(404);
    });

    it('respond with 400 when no owner id is supplied', async () => {
      const res = await upload(memberAgent, {});
      should(res.status).equal(400);
    });

    it('respond with 400 for a non-image upload', async () => {
      const res = await upload(memberAgent, { testCaseId: testCase._id }, './package.json');
      should(res.status).equal(400);
      should(res.body.error).match(/Only image files are supported/);
    });

    it('leaves no orphan file behind when the upload is rejected', async () => {
      const filesBefore = fs.readdirSync(`attachments/${testCase._id}`).length;
      const before = await Attachment.countDocuments({ team: team._id });

      const res = await upload(outsiderAgent, { testCaseId: testCase._id });
      should(res.status).equal(403);

      // multer writes the file before the request is authorised, so the rejection has to
      // clean it up - otherwise every denied upload silently fills the disk.
      should(await Attachment.countDocuments({ team: team._id })).equal(before);
      should(fs.readdirSync(`attachments/${testCase._id}`).length).equal(filesBefore);
    });

    it('leaves no empty directory behind for an owner that does not exist', async () => {
      const unknownId = '5f7e2b9e8f1b2c0017a1b2c3';
      const res = await upload(memberAgent, { testCaseId: unknownId });
      should(res.status).equal(404);
      should(fs.existsSync(`attachments/${unknownId}`)).equal(false);
    });

    it('uploads to a shared step', async () => {
      const sharedStep = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-at shared',
        steps: [{ action: 'shared thing' }],
      });
      should(sharedStep.status).equal(201);

      const res = await upload(leadAgent, { sharedStepId: sharedStep.body._id });
      should(res.status).equal(201);
      should(res.body.scope).equal('sharedstep');
      should(res.body.sharedStep).equal(sharedStep.body._id);
    });
  });

  describe('GET /attachment', () => {
    it('lists the attachments for a test case', async () => {
      const res = await send(memberAgent, 'get', `attachment?testCaseId=${testCase._id}`);
      should(res.status).equal(200);
      should(res.body.attachments.length).be.above(0);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await send(outsiderAgent, 'get', `attachment?testCaseId=${testCase._id}`);
      should(res.status).equal(403);
    });
  });

  describe('referencing an attachment from a step', () => {
    let attachment;
    let referencingCase;

    before(async () => {
      const res = await upload(memberAgent, { testCaseId: testCase._id });
      attachment = res.body;
    });

    it('accepts a step that references the attachment', async () => {
      const res = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-at case referencing an image',
        steps: [{
          action: 'Compare against the reference image',
          expected: 'Matches ![reference](attachment:x)',
          attachments: [attachment._id],
        }],
      });
      should(res.status).equal(201);
      referencingCase = res.body;
      should(res.body.steps[0].attachments).have.length(1);
    });

    it('freezes the reference into the version', async () => {
      const version = await ManualTestCaseVersion
        .findOne({ testCase: referencingCase._id, version: 1 })
        .lean();
      should(version.steps[0].attachments).have.length(1);
      should(version.steps[0].attachments[0].toString()).equal(attachment._id);
    });

    it('respond with 404 for an attachment that does not exist', async () => {
      const res = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-at bad attachment reference',
        steps: [{ action: 'x', attachments: ['5f7e2b9e8f1b2c0017a1b2c3'] }],
      });
      should(res.status).equal(404);
      should(res.body.message).match(/No attachment found/);
    });

    it('respond with 404 for another team\'s attachment', async () => {
      const foreignCase = await send(outsiderAgent, 'post', 'manual-test-case', {
        team: otherTeam._id.toString(),
        title: 'unit-testing-at foreign case',
        steps: [{ action: 'x' }],
      });
      const foreign = await upload(outsiderAgent, { testCaseId: foreignCase.body._id });
      should(foreign.status).equal(201);

      const res = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-at cross team attachment',
        steps: [{ action: 'x', attachments: [foreign.body._id] }],
      });
      should(res.status).equal(404);
    });

    it('refuses to delete an attachment a frozen version references', async () => {
      const res = await send(memberAgent, 'delete', `attachment/${attachment._id}`);
      should(res.status).equal(409);
      should(res.body.message).match(/frozen test case version/);
      // The file must survive - it is the only copy of what that version's tester saw.
      should(fs.existsSync(attachment.path)).equal(true);
    });

    it('still refuses after the step is removed from the head', async () => {
      const updated = await send(memberAgent, 'put', `manual-test-case/${referencingCase._id}`, {
        steps: [{ action: 'Compare against the reference image', expected: 'no image now' }],
      });
      should(updated.status).equal(200);
      should(updated.body.version).equal(2);

      // v1 still references it, so the image a historical execution renders is protected.
      const res = await send(memberAgent, 'delete', `attachment/${attachment._id}`);
      should(res.status).equal(409);
      should(fs.existsSync(attachment.path)).equal(true);
    });
  });

  describe('DELETE /attachment/:id', () => {
    it('deletes an attachment nothing references, removing its files', async () => {
      const res = await upload(memberAgent, { testCaseId: testCase._id });
      const attachment = res.body;
      should(fs.existsSync(attachment.path)).equal(true);

      const deleted = await send(memberAgent, 'delete', `attachment/${attachment._id}`);
      should(deleted.status).equal(200);
      should(fs.existsSync(attachment.path)).equal(false);
      should(fs.existsSync(attachment.thumbnail)).equal(false);
      const gone = await Attachment.findById(attachment._id).lean();
      should(gone).equal(null);
    });

    it('clears the reference from a head step so nothing renders broken', async () => {
      const uploadRes = await upload(memberAgent, { testCaseId: testCase._id });
      const attachment = uploadRes.body;

      const created = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-at head reference cleanup',
        steps: [{ action: 'x', attachments: [attachment._id] }],
      });
      should(created.status).equal(201);

      // Remove the frozen reference so the delete is permitted, leaving only the head.
      await ManualTestCaseVersion.deleteMany({ testCase: created.body._id }).exec();

      const deleted = await send(memberAgent, 'delete', `attachment/${attachment._id}`);
      should(deleted.status).equal(200);

      const head = await ManualTestCase.findById(created.body._id).lean();
      should(head.steps[0].attachments).have.length(0);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await upload(memberAgent, { testCaseId: testCase._id });
      const denied = await send(outsiderAgent, 'delete', `attachment/${res.body._id}`);
      should(denied.status).equal(403);
    });

    it('respond with 404 for an unknown id', async () => {
      const res = await send(memberAgent, 'delete', 'attachment/5f7e2b9e8f1b2c0017a1b2c3');
      should(res.status).equal(404);
    });
  });

  describe('deleting a test case releases its attachments', () => {
    it('removes the attachment documents and files along with the case', async () => {
      const created = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-at doomed case',
        steps: [{ action: 'x' }],
      });
      const doomed = created.body;

      const uploadRes = await upload(leadAgent, { testCaseId: doomed._id });
      const attachment = uploadRes.body;
      should(fs.existsSync(attachment.path)).equal(true);

      // Reference it from a step, so a frozen version holds it - the case delete has to
      // remove the versions first for the attachment to be collectable.
      const referenced = await send(leadAgent, 'put', `manual-test-case/${doomed._id}`, {
        steps: [{ action: 'x', attachments: [attachment._id] }],
      });
      should(referenced.status).equal(200);

      const deleted = await send(leadAgent, 'delete', `manual-test-case/${doomed._id}`);
      should(deleted.status).equal(200);

      const gone = await Attachment.findById(attachment._id).lean();
      should(gone).equal(null);
      should(fs.existsSync(attachment.path)).equal(false);
    });
  });
});

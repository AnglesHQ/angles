/**
 * Tests for attachments uploaded by automated tests: logs, HAR files, videos, traces,
 * HTML snapshots and images.
 *
 * They are uploaded against the build (the execution does not exist yet while the test
 * runs) and claimed by an execution, or one of its steps, when the execution is saved.
 * The load-bearing rules are that an execution can only claim files from its own build,
 * that files are served in a way a browser will not execute, and that they go away with
 * the execution or build they belong to.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');
const TestExecution = require('../app/models/execution.js');
const Attachment = require('../app/models/attachment.js');
const { Team } = require('../app/models/team.js');
const buildUtils = require('../app/utils/build-utils.js');
const attachmentUtils = require('../app/utils/attachment-utils.js');

const baseUrl = '/rest/api/v1.0/';
const IMAGE = './test/resources/angles_home_page.jpg';

const MEMBER_PASSWORD = 'unit-testing-TaMember1!';
const LEAD_PASSWORD = 'unit-testing-TaLead1!';
const OUTSIDER_PASSWORD = 'unit-testing-TaOutsider1!';

describe('Test attachment API Tests', () => {
  let memberAgent;
  let leadAgent;
  let outsiderAgent;
  let team;
  let otherTeam;
  let environment;
  let build;
  let otherBuild;
  let fixtureDir;
  const files = {};

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

  const upload = (agent, buildId, file, contentType) => new Promise((resolve, reject) => {
    const req = agent.post(`${baseUrl}build/${buildId}/attachment`);
    if (file) req.attach('attachment', file, contentType ? { contentType } : undefined);
    req.end((err, res) => (err ? reject(err) : resolve(res)));
  });

  const download = (agent, url) => new Promise((resolve, reject) => {
    agent.get(`${baseUrl}${url}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .end((err, res) => (err ? reject(err) : resolve(res)));
  });

  const newBuild = (owner, name) => new Build({
    name,
    team: owner,
    environment,
    status: buildUtils.executionStates[0],
    component: owner.components[0]._id,
    suites: [],
    result: new Map(buildUtils.defaultResultMap),
  }).save();

  const removeFixtures = async () => {
    const teams = await Team.find({ name: /^unit-testing-ta-/ }).select('_id').lean();
    const teamIds = teams.map((t) => t._id);
    const builds = await Build.find({ team: { $in: teamIds } }).select('_id').lean();
    const buildIds = builds.map((b) => b._id.toString());
    await attachmentUtils.removeAttachmentsForBuilds(buildIds);
    await Promise.all([
      TestExecution.deleteMany({ build: { $in: buildIds } }).exec(),
      Build.deleteMany({ _id: { $in: buildIds } }).exec(),
      Environment.deleteMany({ name: /^unit-testing-ta-/ }).exec(),
      User.deleteMany({ username: /^unit-testing-ta-/ }).exec(),
      Team.deleteMany({ _id: { $in: teamIds } }).exec(),
    ]);
  };

  before(async () => {
    await removeFixtures();

    team = await new Team({ name: 'unit-testing-ta-team', components: [{ name: 'ta-component' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-ta-other', components: [{ name: 'ta-other' }] }).save();
    environment = await new Environment({ name: 'unit-testing-ta-env' }).save();
    build = await newBuild(team, 'unit-testing-ta-build');
    otherBuild = await newBuild(otherTeam, 'unit-testing-ta-other-build');

    const [memberHash, leadHash, outsiderHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
      bcrypt.hash(OUTSIDER_PASSWORD, 10),
    ]);
    await User.create([
      {
        username: 'unit-testing-ta-member', password: memberHash, role: 'user', teams: [team._id],
      },
      {
        username: 'unit-testing-ta-lead', password: leadHash, role: 'team_lead', teams: [team._id],
      },
      {
        username: 'unit-testing-ta-outsider', password: outsiderHash, role: 'user', teams: [otherTeam._id],
      },
    ]);
    [memberAgent, leadAgent, outsiderAgent] = await Promise.all([
      login('unit-testing-ta-member', MEMBER_PASSWORD),
      login('unit-testing-ta-lead', LEAD_PASSWORD),
      login('unit-testing-ta-outsider', OUTSIDER_PASSWORD),
    ]);

    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'angles-ta-'));
    const write = (name, contents) => {
      const file = path.join(fixtureDir, name);
      fs.writeFileSync(file, contents);
      return file;
    };
    files.log = write('console.log', 'INFO page loaded\nERROR TypeError: x is undefined\n');
    files.har = write('network.har', JSON.stringify({ log: { version: '1.2', entries: [] } }));
    files.video = write('video.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    files.trace = write('trace.zip', Buffer.from('PK\u0003\u0004'));
    files.zip = write('screenshots.zip', Buffer.from('PK\u0003\u0004'));
    files.html = write('page.html', '<html><body><script>alert(1)</script></body></html>');
    files.exe = write('payload.exe', 'MZ');
  });

  after(async () => {
    await removeFixtures();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  describe('POST /build/:buildId/attachment', () => {
    it('stores each supported file with a kind decided from its extension', async () => {
      const expectations = [
        [files.log, 'log', 'text/plain'],
        [files.har, 'har', 'application/json'],
        [files.video, 'video', 'video/webm'],
        [files.trace, 'trace', 'application/zip'],
        [files.zip, 'archive', 'application/zip'],
        [files.html, 'html', 'text/html'],
        [IMAGE, 'image', 'image/jpeg'],
      ];
      // eslint-disable-next-line no-restricted-syntax
      for (const [file, kind, mimeType] of expectations) {
        // Test frameworks usually send octet-stream; the stored type must not depend on it.
        // eslint-disable-next-line no-await-in-loop
        const res = await upload(memberAgent, build._id, file, 'application/octet-stream');
        should(res.status).equal(201, `${path.basename(file)}: ${JSON.stringify(res.body)}`);
        should(res.body.kind).equal(kind);
        should(res.body.mimeType).equal(mimeType);
        should(res.body.originalName).equal(path.basename(file));
        should(res.body.build).equal(build._id.toString());
        should(res.body.size).be.above(0);
        files[`${kind}Id`] = res.body._id;
      }
    });

    it('does not return server paths', async () => {
      const res = await upload(memberAgent, build._id, files.log);
      should(res.status).equal(201);
      should(res.body).not.have.property('path');
      should(res.body).not.have.property('filename');
      should(res.body).not.have.property('thumbnail');
    });

    it('writes the file under the build with a generated name', async () => {
      const stored = await Attachment.findById(files.logId).lean();
      should(stored.scope).equal('build');
      should(stored.path).match(new RegExp(`attachments/${build._id}/`));
      should(stored.path).not.match(/console/);
      should(fs.existsSync(stored.path)).equal(true);
    });

    it('generates a thumbnail for an image only', async () => {
      const image = await Attachment.findById(files.imageId).lean();
      should(image.thumbnail).be.a.String();
      should(fs.existsSync(image.thumbnail)).equal(true);
      const log = await Attachment.findById(files.logId).lean();
      should(log.thumbnail).equal(undefined);
    });

    it('rejects an unsupported file type with a 400', async () => {
      const res = await upload(memberAgent, build._id, files.exe);
      should(res.status).equal(400);
      should(res.body.error).match(/Unsupported attachment type/);
    });

    it('rejects a request without a file with a 400', async () => {
      const res = await upload(memberAgent, build._id);
      should(res.status).equal(400);
    });

    it('returns 404 for an unknown build and leaves no file behind', async () => {
      const missing = '0123456789abcdef01234567';
      const res = await upload(memberAgent, missing, files.log);
      should(res.status).equal(404);
      should(fs.existsSync(path.join(attachmentUtils.ATTACHMENT_ROOT, missing))).equal(false);
    });

    it('returns 403 when uploading to another team\'s build', async () => {
      const res = await upload(outsiderAgent, build._id, files.log);
      should(res.status).equal(403);
    });
  });

  describe('Claiming attachments from an execution', () => {
    let execution;
    let foreignId;

    before(async () => {
      const foreign = await upload(outsiderAgent, otherBuild._id, files.log);
      should(foreign.status).equal(201);
      foreignId = foreign.body._id;
    });

    it('links execution and step attachments when the execution is saved', async () => {
      const res = await send(memberAgent, 'post', 'execution', {
        title: 'unit-testing-ta checkout',
        suite: 'unit-testing-ta suite',
        build: build._id.toString(),
        attachments: [files.videoId, files.traceId, files.harId],
        actions: [{
          name: 'Pay',
          steps: [{
            name: 'Verify confirmation',
            status: 'FAIL',
            timestamp: new Date(),
            attachments: [files.htmlId],
          }],
        }],
      });
      should(res.status).equal(201);
      execution = res.body;
      should(execution.attachments).eql([files.videoId, files.traceId, files.harId]);
      should(execution.actions[0].steps[0].attachments).eql([files.htmlId]);

      const linked = await Attachment.find({ execution: execution._id }).select('_id').lean();
      should(linked.map((a) => a._id.toString()).sort())
        .eql([files.videoId, files.traceId, files.harId, files.htmlId].sort());
    });

    it('drops ids that were not uploaded against the same build', async () => {
      const res = await send(memberAgent, 'post', 'execution', {
        title: 'unit-testing-ta foreign',
        suite: 'unit-testing-ta suite',
        build: build._id.toString(),
        attachments: [foreignId, files.logId],
      });
      should(res.status).equal(201);
      should(res.body.attachments).eql([files.logId]);
      const foreign = await Attachment.findById(foreignId).lean();
      should(foreign.execution).equal(undefined);
    });

    it('rejects malformed attachment ids with a 422', async () => {
      const res = await send(memberAgent, 'post', 'execution', {
        title: 'unit-testing-ta malformed',
        suite: 'unit-testing-ta suite',
        build: build._id.toString(),
        attachments: ['not-an-id'],
      });
      should(res.status).equal(422);
    });

    it('links attachments for executions added in a batch', async () => {
      const log = await upload(memberAgent, build._id, files.log);
      const res = await send(memberAgent, 'put', `build/${build._id}/executions`, {
        executions: [{
          title: 'unit-testing-ta batched',
          suite: 'unit-testing-ta suite',
          attachments: [log.body._id],
        }],
      });
      should(res.status).equal(200);
      const stored = await Attachment.findById(log.body._id).lean();
      should(stored.execution).not.equal(undefined);
      const batched = await TestExecution.findById(stored.execution).lean();
      should(batched.title).equal('unit-testing-ta batched');
    });

    it('drops attachment ids on executions posted with a new build', async () => {
      const res = await send(memberAgent, 'post', 'build', {
        environment: 'unit-testing-ta-env',
        team: 'unit-testing-ta-team',
        component: 'ta-component',
        name: 'unit-testing-ta-new-build',
        start: new Date(),
        executions: [{
          title: 'unit-testing-ta new',
          suite: 'unit-testing-ta suite',
          attachments: [files.logId],
        }],
      });
      should(res.status).equal(201);
      const created = res.body.suites[0].executions[0];
      should(created.attachments).eql([]);
    });

    describe('GET /attachment?executionId=', () => {
      it('lists the attachments an execution claimed, without server paths', async () => {
        const res = await send(memberAgent, 'get', `attachment?executionId=${execution._id}`);
        should(res.status).equal(200);
        const ids = res.body.attachments.map((a) => a._id).sort();
        should(ids).eql([files.videoId, files.traceId, files.harId, files.htmlId].sort());
        res.body.attachments.forEach((attachment) => {
          should(attachment).not.have.property('path');
          should(attachment.kind).be.a.String();
        });
      });

      it('lists every attachment uploaded against a build', async () => {
        const res = await send(memberAgent, 'get', `attachment?buildId=${build._id}`);
        should(res.status).equal(200);
        should(res.body.attachments.length).be.above(6);
      });

      it('returns 403 to another team', async () => {
        const res = await send(outsiderAgent, 'get', `attachment?executionId=${execution._id}`);
        should(res.status).equal(403);
      });
    });

    describe('GET /attachment/:id/file', () => {
      it('serves a log inline with its stored type and safe headers', async () => {
        const res = await download(memberAgent, `attachment/${files.logId}/file`);
        should(res.status).equal(200);
        should(res.headers['content-type']).match(/^text\/plain/);
        should(res.headers['x-content-type-options']).equal('nosniff');
        should(res.headers['content-security-policy']).equal('sandbox');
        should(res.headers['content-disposition']).match(/^inline; filename="console.log"/);
        should(res.body.toString()).match(/TypeError/);
      });

      it('always serves an HTML snapshot as a download', async () => {
        const res = await download(memberAgent, `attachment/${files.htmlId}/file`);
        should(res.status).equal(200);
        should(res.headers['content-disposition']).match(/^attachment; filename="page.html"/);
        should(res.headers['content-security-policy']).equal('sandbox');
      });

      it('serves any attachment as a download when asked', async () => {
        const res = await download(memberAgent, `attachment/${files.videoId}/file?download=true`);
        should(res.status).equal(200);
        should(res.headers['content-type']).equal('video/webm');
        should(res.headers['content-disposition']).match(/^attachment;/);
      });

      it('supports range requests, so a video can be seeked', async () => {
        const res = await new Promise((resolve, reject) => {
          memberAgent.get(`${baseUrl}attachment/${files.videoId}/file`)
            .set('Range', 'bytes=0-1')
            .end((err, response) => (err ? reject(err) : resolve(response)));
        });
        should(res.status).equal(206);
      });

      it('returns 403 to another team', async () => {
        const res = await download(outsiderAgent, `attachment/${files.logId}/file`);
        should(res.status).equal(403);
      });
    });

    describe('DELETE /attachment/:id', () => {
      it('removes the reference from the execution and its steps', async () => {
        let res = await send(memberAgent, 'delete', `attachment/${files.harId}`);
        should(res.status).equal(200);
        res = await send(memberAgent, 'delete', `attachment/${files.htmlId}`);
        should(res.status).equal(200);
        const stored = await TestExecution.findById(execution._id).lean();
        should(stored.attachments.map(String)).eql([files.videoId, files.traceId]);
        should(stored.actions[0].steps[0].attachments).eql([]);
      });
    });

    describe('DELETE /execution/:id', () => {
      it('removes the attachments the execution claimed, files included', async () => {
        const video = await Attachment.findById(files.videoId).lean();
        const res = await send(leadAgent, 'delete', `execution/${execution._id}`);
        should(res.status).equal(200);
        should(await Attachment.countDocuments({ execution: execution._id })).equal(0);
        should(fs.existsSync(video.path)).equal(false);
      });
    });
  });

  describe('DELETE /build/:id', () => {
    it('removes the build\'s attachments and their directory', async () => {
      const disposable = await newBuild(team, 'unit-testing-ta-disposable');
      const res = await upload(memberAgent, disposable._id, files.log);
      should(res.status).equal(201);
      const directory = path.join(attachmentUtils.ATTACHMENT_ROOT, disposable._id.toString());
      should(fs.existsSync(directory)).equal(true);

      const deleted = await send(leadAgent, 'delete', `build/${disposable._id}`);
      should(deleted.status).equal(200);
      should(await Attachment.countDocuments({ build: disposable._id })).equal(0);
      should(fs.existsSync(directory)).equal(false);
    });
  });
});

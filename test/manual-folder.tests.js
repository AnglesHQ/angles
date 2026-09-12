/**
 * Tests for the manual test case folder tree.
 *
 * The load-bearing properties are structural: nesting has to survive a move (a folder
 * dragged elsewhere takes its whole subtree with it), a folder must never end up inside
 * its own subtree (which would strand the branch where no query starting at a root can
 * reach it), and filing a case must not disturb its immutable version history.
 */
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const ManualFolder = require('../app/models/manual-folder.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const { Team } = require('../app/models/team.js');

const baseUrl = '/rest/api/v1.0/';
const MEMBER_PASSWORD = 'unit-testing-MfMember1!';
const LEAD_PASSWORD = 'unit-testing-MfLead1!';

describe('Manual Folder API Tests', () => {
  let memberAgent;
  let leadAgent;
  let team;
  let otherTeam;

  const login = (username, password) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent.post(`${baseUrl}auth/login`).send({ username, password }).end((err, res) => {
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

  const makeFolder = async (name, parent) => {
    const res = await send(leadAgent, 'post', 'manual-folder', {
      team: team._id.toString(), name, parent,
    });
    should(res.status).equal(201);
    return res.body;
  };

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-mf/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mf/ }).exec(),
      ManualFolder.deleteMany({ name: /^unit-testing-mf/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mf/ }).exec(),
    ]);
    team = await new Team({ name: 'unit-testing-mf-team', components: [{ name: 'mf-c' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-mf-other', components: [{ name: 'mf-o' }] }).save();

    const [memberHash, leadHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10), bcrypt.hash(LEAD_PASSWORD, 10),
    ]);
    await User.create({
      username: 'unit-testing-mf-member', password: memberHash, role: 'user', teams: [team._id],
    });
    await User.create({
      username: 'unit-testing-mf-lead', password: leadHash, role: 'team_lead', teams: [team._id],
    });
    memberAgent = await login('unit-testing-mf-member', MEMBER_PASSWORD);
    leadAgent = await login('unit-testing-mf-lead', LEAD_PASSWORD);
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-mf/ }).select('_id').lean();
    await Promise.all([
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mf/ }).exec(),
      ManualFolder.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      User.deleteMany({ username: /^unit-testing-mf/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mf/ }).exec(),
    ]);
  });

  describe('creating folders at any depth', () => {
    it('creates a root folder with an empty path', async () => {
      const root = await makeFolder('unit-testing-mf Checkout');
      should(root.depth).equal(0);
      should(root.path).be.an.Array().and.have.length(0);
      should(root.parent).be.exactly(null);
    });

    it('nests a folder under another', async () => {
      const root = await makeFolder('unit-testing-mf Billing');
      const child = await makeFolder('Payments', root._id);
      should(child.depth).equal(1);
      should(child.path).have.length(1);
      should(child.path[0]).equal(root._id);
    });

    it('nests as deep as asked', async () => {
      let parent;
      const created = [];
      for (let level = 0; level < 6; level += 1) {
        // eslint-disable-next-line no-await-in-loop
        const folder = await makeFolder(`unit-testing-mf L${level}`, parent);
        created.push(folder);
        parent = folder._id;
      }
      should(created[5].depth).equal(5);
      // The path is every ancestor, outermost first - that is what makes a subtree query
      // a single lookup rather than one per level.
      should(created[5].path).have.length(5);
      should(created[5].path[0]).equal(created[0]._id);
      should(created[5].path[4]).equal(created[4]._id);
    });

    it('rejects a duplicate name under the same parent', async () => {
      const root = await makeFolder('unit-testing-mf Dupes');
      await makeFolder('Same', root._id);
      const res = await send(leadAgent, 'post', 'manual-folder', {
        team: team._id.toString(), name: 'Same', parent: root._id,
      });
      should(res.status).equal(409);
    });

    it('allows the same name under a different parent', async () => {
      const a = await makeFolder('unit-testing-mf BranchA');
      const b = await makeFolder('unit-testing-mf BranchB');
      await makeFolder('Shared name', a._id);
      const res = await send(leadAgent, 'post', 'manual-folder', {
        team: team._id.toString(), name: 'Shared name', parent: b._id,
      });
      should(res.status).equal(201);
    });

    it('rejects a duplicate root name', async () => {
      // Mongo treats every null as distinct in a unique index, so roots would escape the
      // constraint without the explicit null default.
      await makeFolder('unit-testing-mf UniqueRoot');
      const res = await send(leadAgent, 'post', 'manual-folder', {
        team: team._id.toString(), name: 'unit-testing-mf UniqueRoot',
      });
      should(res.status).equal(409);
    });

    it('respond with 404 for a parent in another team', async () => {
      const foreign = await new ManualFolder({ team: otherTeam._id, name: 'foreign', depth: 0 }).save();
      const res = await send(leadAgent, 'post', 'manual-folder', {
        team: team._id.toString(), name: 'unit-testing-mf x', parent: foreign._id.toString(),
      });
      should(res.status).equal(404);
    });

    it('respond with 422 for a folder with no name', async () => {
      const res = await send(leadAgent, 'post', 'manual-folder', { team: team._id.toString() });
      should(res.status).equal(422);
    });
  });

  describe('moving a folder', () => {
    let outer;
    let inner;
    let leaf;
    let target;

    before(async () => {
      outer = await makeFolder('unit-testing-mf Outer');
      inner = await makeFolder('Inner', outer._id);
      leaf = await makeFolder('Leaf', inner._id);
      target = await makeFolder('unit-testing-mf Target');
    });

    it('takes the whole subtree with it', async () => {
      const res = await send(leadAgent, 'put', `manual-folder/${inner._id}`, { parent: target._id });
      should(res.status).equal(200);
      const movedLeaf = await ManualFolder.findById(leaf._id).lean();
      // The leaf still sits under Inner, but its ancestors above Inner have changed.
      should(movedLeaf.depth).equal(2);
      should(movedLeaf.path.map((id) => id.toString()))
        .deepEqual([target._id.toString(), inner._id.toString()]);
    });

    it('refuses to move a folder inside itself', async () => {
      const res = await send(leadAgent, 'put', `manual-folder/${target._id}`, { parent: target._id });
      should(res.status).equal(400);
    });

    it('refuses to move a folder inside its own sub-folder', async () => {
      // This is the one that would strand the branch: no query starting at a root could
      // ever reach it again.
      const res = await send(leadAgent, 'put', `manual-folder/${target._id}`, { parent: leaf._id });
      should(res.status).equal(400);
      const unchanged = await ManualFolder.findById(target._id).lean();
      should(unchanged.depth).equal(0);
    });

    it('moves a folder back to the root', async () => {
      const res = await send(leadAgent, 'put', `manual-folder/${inner._id}`, { parent: null });
      should(res.status).equal(200);
      should(res.body.depth).equal(0);
      const movedLeaf = await ManualFolder.findById(leaf._id).lean();
      should(movedLeaf.depth).equal(1);
    });

    it('renames without moving', async () => {
      const res = await send(leadAgent, 'put', `manual-folder/${leaf._id}`, { name: 'Renamed leaf' });
      should(res.status).equal(200);
      should(res.body.name).equal('Renamed leaf');
      should(res.body.depth).equal(1);
    });
  });

  describe('filing test cases', () => {
    let folder;
    let subFolder;
    let testCase;

    before(async () => {
      folder = await makeFolder('unit-testing-mf Filing');
      subFolder = await makeFolder('Deeper', folder._id);
      const created = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-mf filed case',
        steps: [{ action: 'Do something' }],
      });
      testCase = created.body;
    });

    it('creates an unfiled case at the root', async () => {
      should(testCase.folder === null || testCase.folder === undefined).equal(true);
    });

    it('moves a case into a folder', async () => {
      const res = await send(memberAgent, 'put', 'manual-folder/move', {
        testCaseIds: [testCase._id], folder: folder._id,
      });
      should(res.status).equal(200);
      should(res.body.moved).equal(1);
      const stored = await ManualTestCase.findById(testCase._id).lean();
      should(stored.folder.toString()).equal(folder._id);
    });

    it('does not burn a version when a case is filed', async () => {
      // Filing is organisation, not content. A move that bumped the version would churn
      // the history of every case whenever someone reorganised the tree.
      const stored = await ManualTestCase.findById(testCase._id).lean();
      should(stored.version).equal(testCase.version);
      const versions = await ManualTestCaseVersion.countDocuments({ testCase: testCase._id });
      should(versions).equal(1);
    });

    it('leaves no folder on the frozen version', async () => {
      // An execution renders what was tested, not where the case has since been filed.
      const frozen = await ManualTestCaseVersion.findOne({ testCase: testCase._id }).lean();
      should(frozen.folder).equal(undefined);
    });

    it('records the move in the change history', async () => {
      const res = await send(memberAgent, 'get', `manual-test-case/${testCase._id}/history`);
      should(res.status).equal(200);
      const move = res.body.history.find((entry) => entry.action === 'MOVE');
      should(move).not.equal(undefined);
      should(move.changedBy).not.equal(undefined);
    });

    it('lists cases in a folder', async () => {
      const res = await send(memberAgent, 'get', `manual-test-case?teamId=${team._id}&folder=${folder._id}`);
      should(res.status).equal(200);
      should(res.body.testCases.map((c) => c._id)).containEql(testCase._id);
    });

    it('excludes sub-folder cases unless asked', async () => {
      const nested = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-mf nested case',
        folder: subFolder._id,
        steps: [{ action: 'Nested' }],
      });
      should(nested.status).equal(201);
      const shallow = await send(memberAgent, 'get', `manual-test-case?teamId=${team._id}&folder=${folder._id}`);
      should(shallow.body.testCases.map((c) => c._id)).not.containEql(nested.body._id);
    });

    it('includes sub-folder cases when asked', async () => {
      const deep = await send(memberAgent, 'get', `manual-test-case?teamId=${team._id}&folder=${folder._id}&includeSubFolders=true`);
      should(deep.body.testCases.length).be.aboveOrEqual(2);
    });

    it('lists unfiled cases with folder=none', async () => {
      const res = await send(memberAgent, 'get', `manual-test-case?teamId=${team._id}&folder=none`);
      should(res.status).equal(200);
      res.body.testCases.forEach((c) => {
        should(c.folder === null || c.folder === undefined).equal(true);
      });
    });

    it('moves a case back to the root', async () => {
      const res = await send(memberAgent, 'put', 'manual-folder/move', {
        testCaseIds: [testCase._id], folder: null,
      });
      should(res.status).equal(200);
      const stored = await ManualTestCase.findById(testCase._id).lean();
      should(stored.folder).be.exactly(null);
    });

    it('respond with 404 for a folder in another team', async () => {
      const foreign = await new ManualFolder({ team: otherTeam._id, name: 'foreign-file', depth: 0 }).save();
      const res = await send(memberAgent, 'put', 'manual-folder/move', {
        testCaseIds: [testCase._id], folder: foreign._id.toString(),
      });
      should(res.status).equal(404);
    });
  });

  describe('the folder tree', () => {
    it('returns folders nested, with test case counts', async () => {
      const res = await send(memberAgent, 'get', `manual-folder?teamId=${team._id}`);
      should(res.status).equal(200);
      should(res.body.folders).be.an.Array();
      const withChildren = res.body.folders.find((f) => f.children && f.children.length > 0);
      should(withChildren).not.equal(undefined);
      should(res.body.unfiledCount).be.a.Number();
    });

    it('respond with 403 for a team the user is not in', async () => {
      const res = await send(memberAgent, 'get', `manual-folder?teamId=${otherTeam._id}`);
      should(res.status).equal(403);
    });
  });

  describe('deleting a folder', () => {
    let parent;
    let child;
    let occupied;

    before(async () => {
      parent = await makeFolder('unit-testing-mf DeleteParent');
      child = await makeFolder('Child', parent._id);
      occupied = await makeFolder('unit-testing-mf Occupied');
      await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-mf blocks delete',
        folder: occupied._id,
        steps: [{ action: 'Blocking' }],
      });
    });

    it('respond with 409 when the folder holds sub-folders', async () => {
      const res = await send(leadAgent, 'delete', `manual-folder/${parent._id}`);
      should(res.status).equal(409);
      should(res.body.message).match(/sub-folder/);
    });

    it('respond with 409 when the folder holds test cases', async () => {
      const res = await send(leadAgent, 'delete', `manual-folder/${occupied._id}`);
      should(res.status).equal(409);
      should(res.body.message).match(/test case/);
    });

    it('respond with 403 when a plain member deletes', async () => {
      const res = await send(memberAgent, 'delete', `manual-folder/${child._id}`);
      should(res.status).equal(403);
    });

    it('deletes an empty folder', async () => {
      const res = await send(leadAgent, 'delete', `manual-folder/${child._id}`);
      should(res.status).equal(200);
      should(await ManualFolder.findById(child._id).lean()).equal(null);
    });

    it('deletes the parent once it is empty', async () => {
      const res = await send(leadAgent, 'delete', `manual-folder/${parent._id}`);
      should(res.status).equal(200);
    });
  });
});

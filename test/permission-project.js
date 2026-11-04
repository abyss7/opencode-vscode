'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const engine = require('../src/permission-profiles');
const project = require('../src/permission-project');

const temp = fs.mkdtempSync(path.join(process.env.OUT || os.tmpdir(), 'project-permissions-'));
const cwd = path.join(temp, 'workspace');
fs.mkdirSync(cwd);

async function main() {
  const basic = engine.compileLayers();
  assert.equal(engine.selectProfile({}, basic, 'host', 'forbid').choices.host, 'permit');
  assert.equal(engine.evaluate(basic.host, 'permit', 'shell', ['anything'], cwd).effect, 'allow');
  const exact = { action: 'shell', resource: 'echo *\\literal\nnext', effect: 'allow', match: 'exact' };
  assert.equal(engine.evaluate(basic.workspace, 'ask', 'shell', [exact.resource], cwd, [exact]).effect, 'allow');
  assert.equal(engine.evaluate(basic.workspace, 'ask', 'shell', ['echo secret/literal\nnext'], cwd, [exact]).effect, 'ask');
  const literalFile = { action: 'edit', resource: '${workspace}/a?.txt', match: 'exact', effect: 'deny' };
  assert.equal(engine.evaluate(basic.workspace, 'ask', 'edit', ['a?.txt'], cwd, [literalFile]).effect, 'deny');
  assert.equal(engine.evaluate(basic.workspace, 'ask', 'edit', ['ab.txt'], cwd, [literalFile]).effect, 'allow');
  assert.throws(() => project.validate({ version: 1, profiles: { workspace: { rules: [{ ...exact, match: 'prefix' }] } } }));
  assert.throws(() => project.validate({ version: 1, profiles: { workspace: { newActions: 'permit' } } }));

  const plugin = path.join(temp, 'plugin');
  fs.mkdirSync(plugin);
  for (const name of ['runtime.cjs', 'classifier.cjs']) fs.copyFileSync(path.join(__dirname, '../plugins/permission-profiles', name), path.join(plugin, name));
  fs.copyFileSync(path.join(__dirname, '../src/permission-profiles.js'), path.join(plugin, 'engine.cjs'));
  fs.writeFileSync(path.join(plugin, 'project.cjs'), fs.readFileSync(path.join(__dirname, '../src/permission-project.js'), 'utf8')
    .replace("require('./permission-profiles')", "require('./engine.cjs')"));
  let hook;
  let rpc;
  let pending = [];
  const sessions = {
    ses_a: { id: 'ses_a', agent: 'build', location: { directory: cwd } },
    ses_b: { id: 'ses_b', agent: 'build', location: { directory: cwd } },
    ses_child: { id: 'ses_child', agent: 'reviewer', parentID: 'ses_a', location: { directory: cwd } },
  };
  const ctx = {
    location: { directory: cwd },
    session: { get: async ({ sessionID }) => ({ data: sessions[sessionID] }) },
    permission: {
      hook: async (_, callback) => { hook = callback; return { dispose() {} }; },
      list: async (input) => {
        assert.ok(input?.sessionID && sessions[input.sessionID], 'SDK permission.list requires a sessionID');
        return { data: pending.filter((request) => request.sessionID === input.sessionID) };
      },
    },
    tool: { hook: async () => ({ dispose() {} }) },
    rpc: { register: async (_, methods) => { rpc = methods; return { dispose() {} }; } },
  };
  const cleanup = await require(path.join(plugin, 'runtime.cjs')).setup(ctx, {}, path.join(temp, 'state'));
  const config = { layers: [], defaultProfile: 'workspace', newActions: 'ask' };
  for (const sessionID of ['ses_a', 'ses_b']) await rpc.configure({ ...config, sessionID });
  const effect = async (action, resources, sessionID = 'ses_b') => {
    const event = { sessionID, action, resources, effect: 'allow' };
    await hook(event);
    return event;
  };
  const ask = { id: 'per_one', sessionID: 'ses_a', action: 'edit',
    resources: [path.join(temp, 'outside/a.txt'), path.join(temp, 'outside/b.txt')],
    source: { type: 'tool', messageID: 'msg', id: 'call_one' } };
  pending = [ask];
  const input = { sessionID: 'ses_a', toolCallId: 'call_one' };
  const describe = await rpc.describe(input);
  assert.match(describe.reason, /Built-in: edit/);
  assert.equal(describe.profileLabel, 'Workspace');
  assert.equal(describe.choices[0].rules.length, 2);
  assert.equal(describe.choices[1].rules[1].resource, path.join(temp, 'outside/*'));
  await assert.rejects(() => rpc.describe({ ...input, sessionID: 'ses_b' }), /no longer pending/);
  await rpc.remember({ ...input, ...describe, choiceId: 'exact', effect: 'allow' });
  assert.equal((await effect('edit', ask.resources)).effect, 'allow', 'all sessions see saved choices without configure');
  assert.equal((await effect('edit', [...ask.resources, path.join(temp, 'outside/c.txt')])).effect, 'ask', 'every resource must match');
  assert.equal(project.read(cwd).profiles.workspace.rules.length, 2);
  await assert.rejects(() => rpc.remember({ ...input, ...describe, choiceId: 'directory', effect: 'allow' }), /changed/);
  const directory = await rpc.describe(input);
  await rpc.remember({ ...input, ...directory, choiceId: 'directory', effect: 'allow' });
  assert.equal((await effect('edit', [path.join(temp, 'outside/nested/c.txt')])).effect, 'allow');
  // A symlink leaving an allowed subtree must be checked at its real destination.
  fs.mkdirSync(path.join(temp, 'outside'));
  fs.mkdirSync(path.join(temp, 'secret'));
  fs.symlinkSync(path.join(temp, 'secret'), path.join(temp, 'outside/link'));
  assert.equal((await effect('edit', [path.join(temp, 'outside/link/c.txt')])).effect, 'ask');

  pending = [{ ...ask, id: 'per_cmd', action: 'shell', resources: ['echo *'] }];
  const command = await rpc.describe(input);
  await rpc.remember({ ...input, ...command, choiceId: 'exact', effect: 'allow' });
  assert.equal((await effect('shell', ['echo *'])).effect, 'allow');
  assert.equal((await effect('shell', ['echo secret'])).effect, 'ask');
  const saved = project.read(cwd);
  await rpc.configure({ ...config, sessionID: 'ses_b', selected: 'host' });
  const hostRule = { action: 'shell', resource: 'echo *', match: 'exact', effect: 'deny' };
  project.write(cwd, project.withRules(saved, 'host', [hostRule]));
  assert.equal((await effect('shell', ['echo *'])).effect, 'deny', 'Host has separate project rules');
  assert.equal((await effect('shell', ['echo *'], 'ses_a')).effect, 'allow');
  await rpc.configure({ ...config, sessionID: 'ses_b', selected: 'workspace', layers: [
    { name: 'Host', profiles: { workspace: { rules: [{ action: 'shell', resource: '*', effect: 'deny' }] } } },
  ] });
  assert.equal((await effect('shell', ['echo *'])).effect, 'deny', 'saved allow never bypasses a profile deny');
  await rpc.configure({ ...config, sessionID: 'ses_a', agentProfiles: { reviewer: 'read-only' } });
  assert.equal((await effect('edit', ask.resources, 'ses_child')).effect, 'deny', 'child ceiling survives project allow');
  pending = [{ ...ask, sessionID: 'ses_child', id: 'per_child' }];
  const childInput = { sessionID: 'ses_a', toolCallId: 'ses_child:call_one' };
  const child = await rpc.describe(childInput);
  await assert.rejects(() => rpc.remember({ ...childInput, ...child, effect: 'allow', choiceId: 'exact' }), /restriction/);

  pending = [{ ...ask, action: 'shell', resources: ['git push'], id: 'per_deny' }];
  const deny = await rpc.describe(input);
  await rpc.remember({ ...input, ...deny, choiceId: 'exact', effect: 'deny' });
  assert.equal((await effect('shell', ['git push'], 'ses_a')).effect, 'deny');
  pending = [];
  await assert.rejects(() => rpc.remember({ ...input, ...deny, choiceId: 'exact', effect: 'allow' }), /no longer pending/);
  assert.deepEqual(project.choices({ action: 'execute', resources: ['*'] }, cwd), []);

  // Offline removal and malformed files are visible immediately, not cached per session.
  fs.writeFileSync(project.filename(cwd), '{ invalid JSON');
  const invalid = await effect('read', ['file'], 'ses_a');
  assert.equal(invalid.effect, 'deny');
  assert.match(invalid.message, /Cannot read/);
  fs.unlinkSync(project.filename(cwd));
  assert.equal((await effect('shell', ['git push'], 'ses_a')).effect, 'ask');
  await cleanup();
  console.log('PROJECT PERMISSION RULES OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));

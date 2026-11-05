'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileLayers, evaluate, selectProfile, VERSION } = require('../src/permission-profiles');
const { readLayers } = require('../src/permission-service');

const temp = fs.mkdtempSync(path.join(process.env.OUT || os.tmpdir(), 'permission-test-'));
const cleanups = [];
const cwd = path.join(temp, 'workspace');
fs.mkdirSync(cwd);
const rule = (action, resource, effect) => ({ action, resource, effect });
const layer = (name, id, rules) => ({ name, profiles: { [id]: { rules } } });
const check = (profiles, id, action, resources, fallback = 'permit') =>
  evaluate(profiles[id], fallback, action, resources, cwd).effect;

async function main() {
  const profiles = compileLayers([
    layer('Host', 'read-only', [rule('read', 'secrets/*', 'deny')]),
    layer('Workspace', 'read-only', [rule('*', '*', 'allow')]),
    layer('Host', 'workspace', [rule('shell', 'git push *', 'deny'), rule('shell', 'npm *', 'ask')]),
    layer('Workspace', 'workspace', [rule('shell', '*', 'allow')]),
    layer('Folder', 'all', [rule('edit', 'protected/*', 'deny')]),
  ]);
  assert.equal(check(profiles, 'read-only', 'read', ['src/main.js']), 'allow');
  assert.equal(check(profiles, 'read-only', 'read', ['secrets/key']), 'deny');
  assert.equal(check(profiles, 'read-only', 'read', ['src/main.js', 'secrets/key']), 'deny');
  for (const action of ['edit', 'shell', 'execute', 'unknown_mcp_tool']) {
    assert.equal(check(profiles, 'read-only', action, ['anything']), 'deny', action);
  }
  for (const action of ['grep', 'glob']) {
    assert.equal(check(profiles, 'read-only', action, ['*']), 'deny', 'search cannot leak restricted reads');
  }
  assert.equal(check(profiles, 'workspace', 'shell', ['git push']), 'deny');
  assert.equal(check(profiles, 'workspace', 'shell', ['git push origin']), 'deny');
  assert.equal(check(profiles, 'workspace', 'shell', ['npm test']), 'ask');
  assert.equal(check(profiles, 'workspace', 'shell', ['git status']), 'allow');
  assert.equal(check(profiles, 'workspace', 'edit', ['src/new.js']), 'allow');
  assert.equal(check(profiles, 'workspace', 'edit', ['../outside.js']), 'ask');
  fs.symlinkSync(temp, path.join(cwd, 'escape'), 'dir');
  assert.equal(check(profiles, 'workspace', 'edit', ['escape/new.js']), 'ask');
  const alias = compileLayers([layer('Host', 'all', [rule('read', 'escape/*', 'deny')])]);
  assert.equal(check(alias, 'all', 'read', ['escape/data']), 'deny', 'canonical rule prefixes cover symlink aliases');
  assert.equal(check(profiles, 'all', 'edit', ['protected/file']), 'deny');
  assert.equal(check(profiles, 'all', 'shell', ['anything']), 'allow');
  const basic = compileLayers();
  for (const [fallback, result] of [['forbid', 'deny'], ['ask', 'ask'], ['smart', 'smart'], ['permit', 'allow']]) {
    assert.equal(check(basic, 'workspace', 'new_tool', ['x'], fallback), result);
  }
  assert.equal(check(profiles, 'workspace', 'shell', ['npm test', 'unmatched'], 'smart'), 'ask');
  assert.equal(check(profiles, 'workspace', 'shell', ['git push'], 'smart'), 'deny');
  let state = selectProfile({}, basic, 'workspace', 'forbid');
  state = selectProfile(state, basic, 'read-only');
  state = selectProfile(state, basic, 'workspace');
  assert.equal(state.choices.workspace, 'forbid');
  assert.equal(selectProfile({}, basic, 'workspace').choices.workspace, 'ask');
  assert.throws(() => compileLayers([layer('User', 'broken', [rule('edit', '*', 'permitt')])]));
  assert.throws(() => selectProfile({}, basic, 'missing'));
  const fakeSettings = {
    permissionProfiles: { globalValue: { all: { rules: [rule('edit', '*', 'deny')] } }, workspaceValue: { all: { rules: [] } } },
    hostPermissionProfiles: { globalValue: { all: { rules: [rule('shell', '*', 'deny')] } } },
    workspacePermissionProfiles: { globalValue: { bad: {} }, workspaceValue: { all: { rules: [rule('*', '*', 'allow')] } } },
  };
  const layers = readLayers({ Uri: { file: (x) => x }, workspace: {
    getConfiguration: () => ({ inspect: (key) => fakeSettings[key] }),
  } }, cwd);
  const merged = compileLayers(layers);
  assert.equal(check(merged, 'all', 'edit', ['a']), 'deny');
  assert.equal(check(merged, 'all', 'shell', ['cmd']), 'deny');
  assert.equal(merged.bad, undefined);

  // Exercise the actual plugin with a fake SDK: no model calls or live sessions.
  const plugin = path.join(temp, 'plugin');
  fs.mkdirSync(plugin);
  fs.copyFileSync(path.join(__dirname, '../plugins/permission-profiles/runtime.cjs'), path.join(plugin, 'runtime.cjs'));
  fs.copyFileSync(path.join(__dirname, '../src/permission-profiles.js'), path.join(plugin, 'engine.cjs'));
  fs.writeFileSync(path.join(plugin, 'project.cjs'), fs.readFileSync(path.join(__dirname, '../src/permission-project.js'), 'utf8')
    .replace("require('./permission-profiles')", "require('./engine.cjs')"));
  fs.copyFileSync(path.join(__dirname, '../plugins/permission-profiles/classifier.cjs'), path.join(plugin, 'classifier.cjs'));
  fs.copyFileSync(path.join(__dirname, '../plugins/permission-profiles/bridge.cjs'), path.join(plugin, 'bridge.cjs'));
  const { setup } = require(path.join(plugin, 'runtime.cjs'));
  let hook;
  let rpc;
  let toolHook;
  let generations = 0;
  let generate = async () => { generations += 1; return { data: { text: '{"decision":"allow","reason":"Requested local inspection."}' } }; };
  const sessions = {
    ses_root: { id: 'ses_root', agent: 'build', location: { directory: cwd } },
    ses_child: { id: 'ses_child', agent: 'reviewer', parentID: 'ses_root' },
    ses_other: { id: 'ses_other', agent: 'build' },
  };
  const ctx = {
    location: { directory: cwd },
    session: {
      get: async ({ sessionID }) => ({ data: sessions[sessionID] }),
      context: async () => ({ data: [{ type: 'user', text: 'Inspect the project status.' }] }),
    },
    agent: { get: async () => ({ data: { system: 'Review only the operation; output JSON.' } }) },
    experimental: { generate: { text: (...args) => generate(...args) } },
    permission: {
      hook: async (name, callback) => { assert.equal(name, 'evaluate'); hook = callback; return { dispose() {} }; },
      assert: async (input) => {
        const event = { ...input, effect: 'allow' };
        await hook(event);
        if (event.effect !== 'allow') throw new Error(event.effect);
      },
    },
    tool: { hook: async (name, callback) => {
      assert.ok(['execute.before', 'execute.after'].includes(name));
      if (name === 'execute.before') toolHook = callback;
      return { dispose() {} };
    } },
    rpc: { register: async (_, methods) => { rpc = methods; return { dispose() {} }; } },
  };
  const cleanup = await setup(ctx, {}, path.join(plugin, 'state'));
  cleanups.push(cleanup);
  const config = { sessionID: 'ses_root', layers: [], defaultProfile: 'read-only', agentProfiles: { reviewer: 'read-only' } };
  assert.equal((await rpc.configure(config)).selected, 'read-only');
  const event = { sessionID: 'ses_child', action: 'edit', resources: ['file'], effect: 'allow' };
  await hook(event);
  assert.equal(event.effect, 'deny', 'children inherit the parent ceiling');
  await assert.rejects(() => toolHook({ sessionID: 'ses_root', tool: 'execute', messageID: 'm', id: 'c' }), /deny/);
  await assert.rejects(() => toolHook({ sessionID: 'ses_root', tool: 'opaque_mutation', messageID: 'm', id: 'c' }), /deny/);
  const denied = { ...event, action: 'read', effect: 'deny' };
  await hook(denied);
  assert.equal(denied.effect, 'deny', 'earlier hook denies survive');
  assert.equal((await rpc.configure({ ...config, sessionID: 'ses_child', selected: 'all' })).inherited, true);
  const other = { ...event, sessionID: 'ses_other', effect: 'ask' };
  await hook(other);
  assert.equal(other.effect, 'ask', 'unmanaged sessions unchanged');
  await rpc.configure({ ...config, selected: 'workspace', newActions: 'ask' });
  const savedAllow = { sessionID: 'ses_root', action: 'shell', resources: ['unknown cmd'], effect: 'allow' };
  await hook(savedAllow);
  assert.equal(savedAllow.effect, 'ask', 'saved project approvals cannot bypass fallback');
  await rpc.configure({ ...config, selected: 'workspace', newActions: 'forbid' });
  await rpc.configure({ ...config, selected: 'all' });
  const childWrite = { ...event, effect: 'allow' };
  await hook(childWrite);
  assert.equal(childWrite.effect, 'deny', 'child agent default also restricts an All parent');
  const childView = await rpc.configure({ ...config, sessionID: 'ses_child' });
  assert.equal(childView.selected, 'read-only');
  await cleanup();
  cleanups.push(await setup(ctx, {}, path.join(plugin, 'state')));
  assert.equal((await rpc.configure({ ...config, selected: 'workspace' })).newActions, 'forbid', 'survives plugin reload');
  await assert.rejects(() => rpc.configure({ ...config, layers: [layer('X', 'workspace', [rule('*', '*', 'bad')])] }));
  assert.equal((await rpc.configure(config)).newActions, 'forbid', 'invalid changes leave previous state intact');
  await rpc.configure({ ...config, selected: 'workspace', newActions: 'smart' });
  const smartEvent = { sessionID: 'ses_root', action: 'shell', resources: ['git status'], effect: 'ask',
    source: { type: 'tool', messageID: 'msg_smart', id: 'call_smart' } };
  await hook(smartEvent);
  assert.equal(smartEvent.effect, 'allow');
  assert.equal(generations, 1);
  assert.equal((await rpc.reviews({ sessionID: 'ses_root' })).reviews.at(-1).status, 'allow');
  const linkedReview = (await rpc.reviews({ sessionID: 'ses_root' })).reviews.at(-1);
  assert.equal(linkedReview.sessionID, 'ses_root');
  assert.equal(linkedReview.toolCallId, 'call_smart');
  assert.equal(linkedReview.messageId, 'msg_smart');
  await rpc.configure({ ...config, selected: 'workspace', newActions: 'smart', layers: [
    layer('Host', 'workspace', [rule('shell', '*', 'ask')]),
  ] });
  await hook({ ...smartEvent, effect: 'allow' });
  assert.equal(generations, 1, 'explicit asks must not be auto-reviewed');
  await rpc.configure({ ...config, selected: 'workspace', newActions: 'smart' });
  let started;
  let finish;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  generate = () => new Promise((resolve) => { finish = resolve; started(); });
  const pendingEvent = { ...smartEvent };
  const pending = hook(pendingEvent);
  await startedPromise;
  assert.equal((await rpc.reviews({ sessionID: 'ses_root' })).reviews.at(-1).status, 'reviewing');
  await rpc.configure({ ...config, selected: 'read-only' });
  finish({ data: { text: '{"decision":"allow","reason":"OK"}' } });
  await pending;
  assert.equal(pendingEvent.effect, 'deny', 'stale decisions cannot widen the new policy');
  assert.match(pendingEvent.message, /changed during Smart review/);

  // Backend agent switching is rejected even if a stale/forged webview asks for it.
  const Module = require('node:module');
  const load = Module._load;
  let SessionPanel;
  let SessionsProvider;
  try {
    Module._load = function (request) {
      return request === 'vscode' ? {
        TreeItem: class { constructor(label) { this.label = label; } },
        ThemeIcon: class {},
      } : load.apply(this, arguments);
    };
    ({ SessionPanel } = require('../src/session-panel'));
    ({ SessionsProvider } = require('../src/sessions-view'));
  } finally { Module._load = load; }
  const panel = Object.create(SessionPanel.prototype);
  let called = false;
  panel._client = { configOptions: [{ id: 'role', category: 'mode' }], setConfigOption: async () => { called = true; } };
  panel._post = () => {};
  await panel._setConfigOption('role', 'plan');
  assert.equal(called, false);
  const messages = [];
  panel._post = (message) => messages.push(message);
  panel.sessionId = 'ses_root';
  panel.cwd = cwd;
  panel._client.prompt = async () => { throw new Error('Must not send before policy is applied'); };
  panel.deps = { permissions: { configure: async () => { throw new Error('plugin offline'); } },
    getConfig: () => ({ autoApprovePermissions: 'allowAll' }) };
  await panel._prompt('change a file', [], null);
  assert.match(messages.find((item) => item.type === 'error').message, /plugin offline/);
  assert.equal(messages.at(-1).type, 'turnEnd');
  panel._permissions = new Map();
  let answer;
  await panel._onPermission({ requestId: 1, toolCall: {}, options: [
    { optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' },
    { optionId: 'no', kind: 'reject_once' },
  ], respond: (value) => { answer = value; } });
  assert.equal(answer, undefined, 'legacy allowAll cannot bypass profile Ask');
  assert.deepEqual(messages.at(-1).options.map((item) => item.optionId), ['once', 'no']);
  panel._answerPermission(1, 'always');
  assert.equal(answer, undefined);
  panel._answerPermission(1, 'once');
  assert.equal(answer, 'once');
  // Failed persistence never answers the native permission; successful save does.
  answer = undefined;
  const order = [];
  const policy = { revision: 'test-revision', permissionId: 'per_pending', profileLabel: 'Workspace' };
  panel.deps.permissions = {
    configure: async () => ({ selected: 'workspace' }),
    describe: async () => policy,
    remember: async () => { order.push('save'); throw new Error('disk full'); },
  };
  await panel._onPermission({ requestId: 2, toolCall: { toolCallId: 'call_test' }, options: [
    { optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' },
  ], respond: (value) => { order.push('answer'); answer = value; } });
  await panel._rememberPermission({ requestId: 2, effect: 'allow', choiceId: 'exact' });
  assert.equal(answer, undefined);
  assert.match(messages.at(-1).error, /disk full/);
  panel.deps.permissions.remember = async () => { order.push('save'); };
  await panel._rememberPermission({ requestId: 2, effect: 'deny', choiceId: 'exact' });
  assert.equal(answer, 'no');
  assert.deepEqual(order, ['save', 'save', 'answer']);
  assert.equal(panel._permissions.has(2), false);
  const provider = Object.create(SessionsProvider.prototype);
  provider.defaultAgent = () => 'reviewer';
  provider.getCwd = () => cwd;
  provider._groups = [];
  assert.deepEqual(provider.getChildren(), [], 'session defaults no longer clutter the session tree');
  const { OpenCodeApi } = require('../src/api');
  const api = Object.create(OpenCodeApi.prototype);
  api._request = async (method, url, body) => {
    assert.equal(method, 'POST');
    assert.match(url, /\/api\/rpc\/vscode-permission-profiles\/status\?location%5Bdirectory%5D=/);
    assert.deepEqual(body, { input: {} });
    return { output: { version: VERSION } };
  };
  assert.equal((await api.permissionProfiles('status', {}, cwd)).version, VERSION);
  console.log('PERMISSION PROFILES OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    for (const cleanup of cleanups) await cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  });

'use strict';

const assert = require('node:assert/strict');
const { BackgroundRuns, backgroundRun } = require('../src/background-runs');
const { SessionClient, toolUpdate } = require('../src/session-client');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name) {
  if (name === 'vscode') return {
    Uri: { joinPath: (...parts) => parts.join('/') },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  };
  return originalLoad.apply(this, arguments);
};
const { SessionPanel } = require('../src/session-panel');
const { SessionsProvider } = require('../src/sessions-view');
Module._load = originalLoad;

const part = (id, shellID, extra = {}) => ({ type: 'tool', id, name: 'shell', state: {
  status: 'completed', input: { command: `echo ${id}`, background: true },
  metadata: { shellID, status: 'running' }, ...extra,
} });
const history = (...parts) => [{ id: 'answer', type: 'assistant', content: parts, time: {} }];
const missing = () => Object.assign(new Error('Not found'), { statusCode: 404 });
function fixture() {
  const data = { calls: [], shells: new Map(), history: new Map(), deletes: [], output: 'captured output' };
  const api = {
    listAllMessages: async (id) => data.history.get(id) || [],
    _request: async (method, path) => {
      data.calls.push({ method, path });
      const url = new URL(path, 'http://test');
      assert.equal(url.searchParams.get('location[directory]'), '/work');
      if (url.pathname === '/api/shell') return { data: [...data.shells.values()].filter((shell) => shell.status === 'running') };
      const id = url.pathname.split('/')[3];
      const info = data.shells.get(id);
      if (!info) throw missing();
      if (method === 'DELETE') {
        if (data.failDelete) throw new Error('Server unavailable');
        data.deletes.push(id);
        data.shells.delete(id);
        return;
      }
      if (url.pathname.endsWith('/output')) return { data: { output: data.output, cursor: 15, size: 15, truncated: false } };
      if (data.hold) return data.hold;
      return { data: structuredClone(info) };
    },
  };
  api.background = new BackgroundRuns(api);
  const add = (id, sessionID = 'parent', status = 'running', exit) => data.shells.set(id,
    { id, status, exit, metadata: { sessionID }, time: { started: 1 }, command: id });
  return { api, data, add, service: api.background };
}

(async () => {
  const f = fixture();
  f.add('sh_a'); f.add('sh_b'); f.add('sh_foreground'); f.add('sh_other', 'other');
  const messages = history(part('a', 'sh_a'), part('b', 'sh_b'));
  f.data.history.set('parent', messages);
  assert.equal(backgroundRun(part('fg', undefined)), null);
  assert.equal(backgroundRun(part('bad', '../shell')), null);
  assert.equal(toolUpdate(part('a', 'sh_a')).background.id, 'sh_a');
  assert.deepEqual([...await f.service.discover('/work')], ['parent'], 'foreground and unrelated processes do not become background tasks');
  let runs = await f.service.refresh('parent', '/work', messages);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].output, 'captured output');
  assert.equal(runs[0].status, 'running', 'tool completion is not shell completion');

  await assert.rejects(() => f.service.stop('other', '/work', 'a'), /not running/);
  await f.service.stop('parent', '/work', 'a');
  assert.deepEqual(f.data.deletes, ['sh_a'], 'Stop targets exactly one shell');
  runs = await f.service.refresh('parent', '/work', messages);
  assert.equal(runs[0].status, 'stopped');
  assert.equal(runs[0].output, 'captured output', 'output survives server removal');
  assert.equal(runs[1].status, 'running');

  f.data.failDelete = true;
  await assert.rejects(() => f.service.stop('parent', '/work', 'b'), /Server unavailable/);
  assert.equal(f.service.sessions.get('parent').get('b').status, 'running', 'failed Stop can be retried');
  f.data.failDelete = false;
  f.add('sh_b', 'parent', 'exited', 7);
  await f.service.stop('parent', '/work', 'b');
  assert.equal(f.service.sessions.get('parent').get('b').exit, 7, 'natural failure wins a Stop race');
  assert.deepEqual(f.data.deletes, ['sh_a']);
  assert.deepEqual([...await f.service.discover('/work')], [], 'stale history cannot keep sidebar blinking');

  const restored = new BackgroundRuns(f.api);
  runs = await restored.refresh('parent', '/work', messages);
  assert.equal(runs[0].status, 'unavailable', 'a removed shell is not resurrected on replay');
  assert.equal(runs[1].exit, 7);
  f.add('sh_wrong', 'other');
  const wrong = history(part('wrong', 'sh_wrong'));
  runs = await restored.refresh('parent', '/work', wrong);
  assert.equal(runs.find((run) => run.id === 'sh_wrong').status, 'unknown');
  assert.match(runs.find((run) => run.id === 'sh_wrong').error, /belong/);

  // A GET started before Stop must not revive the deleted process afterward.
  const race = fixture(); race.add('sh_race');
  const raceHistory = history(part('race', 'sh_race'));
  await race.service.refresh('parent', '/work', raceHistory);
  let release;
  race.data.hold = new Promise((resolve) => { release = resolve; });
  const pending = race.service.refresh('parent', '/work', raceHistory);
  delete race.data.hold;
  await race.service.stop('parent', '/work', 'race');
  release({ data: { status: 'running', metadata: { sessionID: 'parent' } } });
  await pending;
  assert.equal(race.service.sessions.get('parent').get('race').status, 'stopped');

  // Session integration replays known background jobs independently of idle.
  const c = fixture(); c.add('sh_c');
  const client = new SessionClient({ api: c.api, cwd: '/work' });
  client.sessionId = 'parent';
  client.messages.set('answer', history(part('c', 'sh_c'))[0]);
  let emitted;
  client.on('background', (value) => { emitted = value; });
  await client.refreshBackground();
  assert.equal(emitted[0].status, 'running');
  assert.ok(client.backgroundTimer);
  client.dispose();
  assert.equal(client.closed, true);

  const panel = Object.create(SessionPanel.prototype);
  Object.assign(panel, { panel: { active: false }, deps: { extensionUri: '/extension' },
    _permissions: new Map(), _elicitations: new Map(), _backgroundRunning: true, _focusIfActive() {} });
  panel._setIcon('idle'); assert.match(panel.panel.iconPath, /background.svg$/);
  panel._setIcon('working'); assert.match(panel.panel.iconPath, /working.svg$/);
  panel._setIcon('done'); assert.match(panel.panel.iconPath, /done.svg$/);
  panel.panel.active = true;
  panel._onViewState(); assert.match(panel.panel.iconPath, /background.svg$/, 'viewed green tab falls back to background');
  panel._permissions.set('request', {}); panel._refreshAttention();
  assert.match(panel.panel.iconPath, /attention.svg$/);
  panel._permissions.clear(); panel._backgroundRunning = false; panel._refreshAttention();
  assert.match(panel.panel.iconPath.dark, /dark.svg$/);

  const provider = new SessionsProvider({}, () => '/work', () => {});
  provider._background.add('parent');
  const session = { id: 'parent', time: {}, _activity: 'idle' };
  assert.equal(provider.sessionTreeItem(session).iconPath.id, 'terminal');
  assert.equal(provider.sessionTreeItem({ ...session, _activity: 'running' }).iconPath.id, 'loading~spin');
  provider._background.clear();
  assert.equal(provider.sessionTreeItem(session).iconPath.id, 'comment-discussion');
  provider.dispose();
  console.log('Background run lifecycle, ownership, races, replay and icon priorities passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

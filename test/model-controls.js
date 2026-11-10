'use strict';

const assert = require('node:assert/strict');
const { SessionClient } = require('../src/session-client');
const { OpenCodeApi } = require('../src/api');
const Module = require('node:module');
const originalLoad = Module._load;
let SessionPanel;
try {
  Module._load = function (request) {
    return request === 'vscode' ? {} : originalLoad.apply(this, arguments);
  };
  ({ SessionPanel } = require('../src/session-panel'));
} finally {
  Module._load = originalLoad;
}

(async () => {
  const api = new OpenCodeApi({ command: 'opencode' });
  api._request = async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/model/default?location%5Bdirectory%5D=%2Fwork+folder');
    return { data: { providerID: 'p', id: 'preferred' } };
  };
  assert.deepEqual(await api.getDefaultModel('/work folder'), { providerID: 'p', id: 'preferred' });

  let session = {};
  let defaultModel = { providerID: 'p', id: 'preferred' };
  let agents = [{ id: 'build', name: 'Build' }];
  const models = [
    { providerID: 'p', id: 'first', name: 'First', type: 'chat', variants: ['high'] },
    { providerID: 'p', id: 'preferred', name: 'Preferred', type: 'chat', variants: [{ id: 'low' }, { id: 'high' }] },
    { providerID: 'p', id: 'plain', name: 'Plain', variants: [] },
    { providerID: 'other', id: 'preferred', name: 'Preferred', type: 'chat', variants: [] },
    { providerID: 'p', id: 'disabled', type: 'chat', enabled: false },
    { providerID: 'p', id: 'image', type: 'image' },
  ];
  const writes = [];
  const client = new SessionClient({ cwd: '/work folder', api: {
    getSession: async () => session,
    getDefaultModel: async (cwd) => { assert.equal(cwd, '/work folder'); return defaultModel; },
    listModels: async () => models,
    listAgents: async () => agents,
    _request: async (method, path, body) => {
      assert.equal(method, 'POST');
      assert.equal(path, '/api/session/ses_test/model');
      writes.push(body);
      session = { ...session, model: { ...body.model, variant: body.model.variant || 'default' } };
    },
  } });
  client.sessionId = 'ses_test';
  const option = (id) => client.configOptions.find((item) => item.id === id);
  await client.refreshConfig();
  assert.equal(option('model').currentValue, 'p/preferred', 'use server default, not catalog order');
  assert.deepEqual(option('model').options.map((item) => item.value), ['p/first', 'p/preferred', 'p/plain', 'other/preferred']);
  assert.deepEqual(option('model').options.map((item) => item.name), ['p/First', 'p/Preferred', 'p/Plain', 'other/Preferred'],
    'identically named models remain distinguishable by provider');
  assert.equal(option('effort').currentValue, 'default');
  assert.deepEqual(option('effort').options.map((item) => item.value), ['low', 'high', 'default']);
  assert.equal(writes.length, 0, 'opening a session must not pin the inherited default');

  await client.setConfigOption('effort', 'high');
  assert.deepEqual(writes.at(-1), { model: { providerID: 'p', id: 'preferred', variant: 'high' } });
  assert.equal(option('model').currentValue, 'p/preferred');
  assert.equal(option('effort').currentValue, 'high');
  await client.setConfigOption('model', 'p/preferred');
  assert.equal(option('effort').currentValue, 'high', 'reselecting the model keeps effort');
  await client.setConfigOption('model', 'p/first');
  assert.equal(option('effort').currentValue, 'default', 'switching models resets effort even if supported');
  await client.setConfigOption('effort', 'high');
  await client.setConfigOption('effort', 'default');
  assert.deepEqual(writes.at(-1), { model: { providerID: 'p', id: 'first' } }, 'Default removes the variant');
  assert.equal(option('effort').options.filter((item) => item.value === 'default').length, 1,
    'the server default sentinel must not produce a duplicate option');

  const restored = new SessionClient({ api: client.api, cwd: client.cwd });
  restored.sessionId = client.sessionId;
  await restored.refreshConfig();
  assert.deepEqual(restored.configOptions, client.configOptions, 'selection survives reopening');
  await client.setConfigOption('model', 'p/plain');
  assert.equal(option('effort'), undefined, 'models without variants have no Effort control, as in ACP');
  const count = writes.length;
  for (const [id, value] of [['effort', 'high'], ['effort', 'default'], ['model', 'p/preferred#high'], ['mode', 'build']]) {
    await assert.rejects(client.setConfigOption(id, value), /Unknown/);
  }
  assert.equal(writes.length, count, 'invalid selections never reach the server');

  session = { agent: 'custom' };
  agents = [{ id: 'custom', name: 'Custom', model: { providerID: 'p', id: 'first', variant: 'high' } }];
  await client.refreshConfig();
  assert.equal(option('model').currentValue, 'p/preferred', 'default resolution belongs to the server, as in ACP');
  assert.equal(option('effort').currentValue, 'default');
  session.model = { providerID: 'p', id: 'preferred', variant: 'low' };
  await client.refreshConfig();
  assert.equal(option('model').currentValue, 'p/preferred', 'explicit session selection wins');
  assert.equal(option('effort').currentValue, 'low');
  let panelRef;
  SessionPanel.prototype._syncModelOptions.call({ _setModelRef: (ref) => { panelRef = ref; } }, client.configOptions);
  assert.deepEqual(panelRef, session.model, 'usage context receives the separate effort selection');
  await client.setConfigOption('effort', 'default');
  SessionPanel.prototype._syncModelOptions.call({ _setModelRef: (ref) => { panelRef = ref; } }, client.configOptions);
  assert.deepEqual(panelRef, { providerID: 'p', id: 'preferred' });

  session = {}; agents = []; defaultModel = null;
  await client.refreshConfig();
  assert.equal(option('model').options[0].value, '', 'missing default gets an honest placeholder');
  assert.equal(option('model').currentValue, '');
  assert.equal(option('effort'), undefined);
  session.model = { providerID: 'missing', id: 'model', variant: 'custom' };
  await client.refreshConfig();
  assert.equal(option('model').options[0].value, 'missing/model', 'unlisted current model stays visible');
  assert.equal(option('effort').currentValue, 'custom');

  const workspace = () => {
    const values = new Map();
    return { get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value) => { values.set(key, value); } };
  };
  const history = workspace();
  const messages = [];
  let broadcasts = 0;
  const makePanel = (state) => {
    const panel = Object.create(SessionPanel.prototype);
    panel.deps = { workspaceState: state, log: () => {}, onRecentModelsChanged: () => { broadcasts++; } };
    panel.panel = { webview: { postMessage: async (message) => { messages.push(message); } } };
    panel._syncModelOptions = () => {};
    panel._client = { configOptions: [{ id: 'model', category: 'model', currentValue: 'p/initial' }],
      async setConfigOption(id, value) {
        if (value === 'p/fail') throw new Error('Rejected');
        this.configOptions = [{ id, category: 'model', currentValue: value }];
        return this.configOptions;
      } };
    return panel;
  };
  const firstPanel = makePanel(history);
  for (const value of ['p/one', 'p/two', 'p/three', 'p/four', 'p/two']) {
    await firstPanel._setConfigOption('model', value);
  }
  assert.deepEqual(history.get('opencode.recentModels'), ['p/two', 'p/four', 'p/three', 'p/one']);
  assert.equal(broadcasts, 5);
  await firstPanel._setConfigOption('model', 'p/fail');
  assert.deepEqual(history.get('opencode.recentModels'), ['p/two', 'p/four', 'p/three', 'p/one'],
    'rejected selections never enter Recent');
  makePanel(history).refreshRecentModels();
  assert.deepEqual(messages.at(-1).configOptions[0].recentValues, history.get('opencode.recentModels'),
    'other tabs and reopened panels share workspace history');
  makePanel(workspace()).refreshRecentModels();
  assert.deepEqual(messages.at(-1).configOptions[0].recentValues, [], 'different workspaces have independent history');
  const broken = makePanel({ get: () => [], update: async () => { throw new Error('Storage unavailable'); } });
  await broken._setConfigOption('model', 'p/one');
  assert.equal(messages.at(-1).configOptions[0].currentValue, 'p/one', 'storage failure does not undo a successful model selection');
  console.log('MODEL CONTROLS OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

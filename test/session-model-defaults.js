'use strict';

const assert = require('node:assert/strict');
const { SessionClient } = require('../src/session-client');

(async () => {
  let documents = [{ info: { model: { providerID: 'p', model: 'chat', variant: 'high' } } }];
  let agents = [{ id: 'build', mode: 'primary' }];
  const sessions = new Map();
  const requests = [];
  const api = {
    getConfig: async () => documents,
    listAgents: async () => agents,
    getDefaultModel: async () => ({ providerID: 'p', id: 'chat' }),
    listModels: async () => [{ providerID: 'p', id: 'chat', variants: ['low', 'high'] },
      { providerID: 'q', id: 'other', variants: ['low', 'high'] }],
    getSession: async (id) => sessions.get(id),
    _request: async (method, path, body) => {
      assert.equal(method, 'POST');
      assert.equal(path, '/api/session');
      requests.push(body);
      if (sessions.has(body.id)) throw new Error('Already exists');
      sessions.set(body.id, { ...body });
      return { data: sessions.get(body.id) };
    },
  };
  const client = new SessionClient({ api, cwd: '/work' });
  client.reconcile = async () => {};
  await client.newSession(undefined, 'ses_initial');
  assert.deepEqual(requests.at(-1).model, { providerID: 'p', id: 'chat', variant: 'high' });
  assert.equal(client.configOptions.find((item) => item.id === 'effort').currentValue, 'high');

  documents.push({ info: { model: 'p/chat#low' } });
  await client.newSession('build', 'ses_project');
  assert.equal(requests.at(-1).model.variant, 'low', 'project model overrides global model');
  await client.loadSession('ses_initial');
  assert.equal(client.configOptions.find((item) => item.id === 'effort').currentValue, 'high',
    'changing the default must not modify an existing session');
  await client.newSession(undefined, 'ses_initial');
  assert.equal(client.modelRef.variant, 'high', 'reserved-ID recovery retains the original selection');

  documents.push({ info: { model: { providerID: 'p', model: 'chat' } } });
  await client.newSession('build', 'ses_plain');
  assert.equal(requests.at(-1).model, undefined, 'a higher-priority reference without a variant clears the default');
  assert.equal(client.configOptions.find((item) => item.id === 'effort').currentValue, 'default');

  documents = [{ info: { model: 'p/chat#high' } }];
  agents = [{ id: 'build', mode: 'primary', model: { providerID: 'q', id: 'other', variant: 'low' } }];
  await client.newSession(undefined, 'ses_agent');
  assert.deepEqual(requests.at(-1).model, agents[0].model, 'default agent selection has priority');
  agents.push({ id: 'review', mode: 'primary', model: { providerID: 'q', id: 'other' } });
  await client.newSession('review', 'ses_review');
  assert.equal(requests.at(-1).model, undefined, 'do not copy the global variant into another agent model');
  documents = [];
  agents = [];
  await client.newSession(undefined, 'ses_unconfigured');
  assert.equal(requests.at(-1).model, undefined, 'leave unconfigured model selection to the server');
  console.log('SESSION MODEL DEFAULTS OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

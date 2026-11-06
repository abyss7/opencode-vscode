'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return {};
  return originalLoad.apply(this, arguments);
};
const { SessionPanel } = require('../src/session-panel');
Module._load = originalLoad;
const { SessionClient } = require('../src/session-client');
const { withClientContext } = require('../src/client-context');

(async () => {
  const sent = [], updates = [];
  let inbox = [], history = [], lost = false;
  const api = {
    getSession: async () => ({ _activity: 'idle' }),
    listAllMessages: async () => history,
    listMessages: async () => [...history].reverse(),
    _request: async (method, path, body) => {
      if (method === 'POST') {
        sent.push({ path, body });
        // Native first-admission-wins contract, including already delivered IDs.
        const delivered = history.find((message) => message.id === body.id);
        let item = inbox.find((entry) => entry.id === body.id);
        if (!item) {
          const { id, delivery, ...payload } = body;
          item = { id, type: 'user', time: { created: 1 }, payload: delivered ? { text: delivered.text } : payload };
          if (!delivered) inbox.push(item);
        }
        if (lost) throw new Error('Lost response');
        return { data: item };
      }
      return { data: path.endsWith('/inbox') ? inbox : [] };
    },
  };
  const client = new SessionClient({ api, cwd: '/work' });
  client.sessionId = 'ses_test';
  client.schedule = () => {};
  const panel = Object.create(SessionPanel.prototype);
  Object.assign(panel, { _client: client, sessionId: 'ses_test', deps: { log() {} }, _post: (event) => updates.push(event) });
  client.on('submission', (event) => updates.push(event));
  const original = { id: 'msg_retry', payload: { text: withClientContext('Original message', { id: 'selection' }),
    files: [{ uri: 'data:image/png;base64,AA==' }], agents: [{ name: 'build' }], skills: [{ name: 'example' }],
    metadata: { custom: true },
  } };
  await panel._onMessage({ type: 'resend', item: original });
  assert.deepEqual(sent[0], { path: '/api/session/ses_test/prompt', body: { ...original.payload, id: original.id, delivery: 'queue' } });
  assert.equal(sent[0].body.text.split('<opencode-client-context').length, 2, 'original context is not duplicated');
  assert.equal(updates.at(-1).state, 'queued');
  lost = true;
  await panel._onMessage({ type: 'resend', item: original });
  assert.equal(client.submissions.get(original.id).state, 'unknown');
  lost = false;
  await panel._onMessage({ type: 'resend', item: original });
  assert.equal(inbox.length, 1, 'stable ID makes retries idempotent');
  history = [{ id: original.id, type: 'user', text: original.payload.text, time: { created: 1 } }];
  inbox = [];
  await panel._onMessage({ type: 'resend', item: original });
  assert.equal(inbox.length, 0, 'a retry of delivered work reconciles to history');
  assert.equal(client.submissions.size, 0);
  await panel._onMessage({ type: 'resend', item: { id: 'msg_local', selection: { id: 'local-selection' }, payload: { text: 'Local draft' } } });
  assert.equal(sent.at(-1).body.text, withClientContext('Local draft', { id: 'local-selection' }));
  await panel._onMessage({ type: 'resend', item: { id: 'msg_image', payload: { files: original.payload.files } } });
  assert.deepEqual(sent.at(-1).body.files, original.payload.files, 'image-only retry survives the host prompt guard');
  panel.deps.permissions = {};
  panel._permissionsBeforePrompt = async () => false;
  const count = sent.length;
  await panel._onMessage({ type: 'resend', item: original });
  assert.equal(sent.length, count, 'resend uses the normal permission-settings flow');
  assert.equal(updates.at(-1).state, 'failed');
  client.dispose();
  console.log('SESSION RESEND OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

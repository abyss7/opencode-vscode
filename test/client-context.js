'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { withClientContext, visiblePrompt, DESCRIPTION } = require('../src/client-context');

const originalLoad = Module._load;
Module._load = function (name) {
  if (name === 'vscode') return {};
  return originalLoad.apply(this, arguments);
};
const { SessionPanel } = require('../src/session-panel');
Module._load = originalLoad;

function panel() {
  const sent = [];
  const queued = [];
  const instance = Object.create(SessionPanel.prototype);
  Object.assign(instance, {
    sessionId: 'ses_test', _busy: false, _queuedCount: 0, _disposed: false,
    _client: { closed: false, prompt: async (blocks) => { sent.push(blocks); return { stopReason: 'end_turn' }; } },
    deps: { log() {}, api: { prompt: async (...args) => queued.push(args) } },
    _startTurn() {}, _finishTurn() {}, _afterTurn() {}, _post() {},
  });
  return { instance, sent, queued };
}

(async () => {
  const prompt = 'Explain the queue.\nKeep the answer short.';
  assert.equal(visiblePrompt(withClientContext(prompt)), prompt);
  assert.equal(visiblePrompt('An ordinary <client-context>example</client-context>'), 'An ordinary <client-context>example</client-context>');
  assert.match(DESCRIPTION, /Mermaid/);
  assert.match(DESCRIPTION, /KaTeX/);

  const { instance, sent, queued } = panel();
  await instance._prompt(prompt, []);
  assert.equal(sent[0][0].text, withClientContext(prompt));
  await instance._prompt('', [{ data: 'image-bytes', mimeType: 'image/png' }]);
  assert.equal(sent[1][0].text, withClientContext(''));
  assert.deepEqual(sent[1][1], { type: 'image', data: 'image-bytes', mimeType: 'image/png' });
  await instance._prompt('', []);
  assert.equal(sent.length, 2, 'empty input must not send a context-only turn');
  instance._busy = true;
  await instance._prompt('Follow up', []);
  assert.deepEqual(queued, [['ses_test', withClientContext('Follow up'), { delivery: 'queue' }]]);
  assert.equal(sent.length, 2, 'busy input uses the queue, not a second ACP prompt');
  console.log('CLIENT CONTEXT OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

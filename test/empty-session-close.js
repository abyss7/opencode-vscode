'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return {};
  return load.apply(this, arguments);
};
const { SessionPanel } = require('../src/session-panel');
Module._load = load;

function panel() {
  return Object.assign(Object.create(SessionPanel.prototype), {
    newSessionId: 'ses_new', sessionId: 'ses_new',
    deps: {}, _post() {},
  });
}

(async () => {
  const empty = panel();
  assert.equal(empty.deleteIfEmptyOnClose, false, 'an open tab is retained');
  empty._disposed = true;
  assert.equal(empty.deleteIfEmptyOnClose, true);

  const existing = panel();
  existing.newSessionId = undefined;
  existing._disposed = true;
  assert.equal(existing.deleteIfEmptyOnClose, false, 'existing sessions are retained');

  const shutdown = panel();
  shutdown.panel = { dispose() { shutdown._disposed = true; } };
  shutdown._cleanup = () => {};
  shutdown.dispose();
  assert.equal(shutdown.deleteIfEmptyOnClose, false, 'shutdown and explicit deletion do not auto-delete');

  const sending = panel();
  let release;
  sending._client = { prompt: () => new Promise((resolve) => { release = resolve; }) };
  const prompt = sending._prompt('Hello', []);
  assert.ok(release, 'submission has started but is not acknowledged yet');
  sending._disposed = true;
  assert.equal(sending.deleteIfEmptyOnClose, false, 'in-flight messages are retained');
  release();
  await prompt;

  const blank = panel();
  blank._client = { prompt() { throw new Error('Blank input must not be submitted'); } };
  await blank._prompt('   ', []);
  blank._disposed = true;
  assert.equal(blank.deleteIfEmptyOnClose, true, 'blank input leaves the session empty');

  console.log('EMPTY SESSION CLOSE OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

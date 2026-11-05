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

function fixture() {
  const messages = [];
  const panel = Object.create(SessionPanel.prototype);
  Object.assign(panel, {
    sessionId: 'session', _client: {}, panel: { active: true },
    deps: { api: { getSession: async () => ({ time: { busy: 20, idle: 10 } }) }, log: () => {} },
    _post: (message) => messages.push(message), _setIcon: () => {},
    _refreshSubagents: () => {}, _afterTurn: () => {},
    _reloadTranscript: async () => messages.push({ type: 'reload' }),
  });
  return { panel, messages };
}

(async () => {
  const { panel, messages } = fixture();
  await panel._refreshServerStatus();
  assert.equal(panel._busy, true, 'opening a running session adopts server state');
  assert.equal(panel._externalTurn, true);
  assert.deepEqual(messages, [{ type: 'status', state: 'busy' }]);
  await panel._refreshServerStatus();
  assert.equal(messages.length, 1, 'polling must not restart the activity timer');
  panel.deps.api.getSession = async () => { throw new Error('offline'); };
  await panel._refreshServerStatus();
  assert.equal(panel._busy, true, 'a failed poll is not completion');
  panel.deps.api.getSession = async () => ({ time: { busy: 20, idle: 30 } });
  await panel._refreshServerStatus();
  assert.equal(panel._busy, false);
  assert.deepEqual(messages.slice(1), [{ type: 'reload' }, { type: 'status', state: 'ready' }]);

  const race = fixture();
  let resolve;
  race.panel.deps.api.getSession = () => new Promise((done) => { resolve = done; });
  const poll = race.panel._refreshServerStatus();
  race.panel._startTurn();
  resolve({ time: { busy: 20, idle: 30 } });
  await poll;
  assert.equal(race.panel._busy, true, 'stale idle cannot finish a local prompt');
  assert.equal(race.panel._externalTurn, false);
  assert.equal(race.messages.length, 1);
  race.panel.deps.api.getSession = () => { throw new Error('must not poll a local turn'); };
  race.panel.deps.log = () => assert.fail('local turn was polled');
  await race.panel._refreshServerStatus();

  const disposed = fixture();
  disposed.panel.deps.api.getSession = () => new Promise((done) => { resolve = done; });
  const pending = disposed.panel._refreshServerStatus();
  disposed.panel._disposed = true;
  resolve({ time: { busy: 20 } });
  await pending;
  assert.equal(disposed.messages.length, 0);
  console.log('Session status tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

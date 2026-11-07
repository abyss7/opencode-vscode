'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return {};
  return originalLoad.apply(this, arguments);
};
const { SessionPanel } = require('../src/session-panel');
const { isBusy } = require('../src/sessions-view');
Module._load = originalLoad;
const { OpenCodeApi } = require('../src/api');
const { sessionActivity } = require('../src/session-activity');
const { CONTINUE_TEXT } = require('../src/session-continuation');

function fixture() {
  const messages = [];
  const panel = Object.create(SessionPanel.prototype);
  Object.assign(panel, {
    sessionId: 'session', _client: {}, panel: { active: true },
    deps: { api: { getSession: async () => ({ _activity: 'running', time: { busy: 20, idle: 10 } }) }, log: () => {} },
    _post: (message) => messages.push(message), _setIcon: () => {},
    _refreshSubagents: () => {}, _afterTurn: () => {},
    _reloadTranscript: async () => messages.push({ type: 'reload' }),
  });
  return { panel, messages };
}

(async () => {
  const api = new OpenCodeApi();
  let requests = 0;
  api._request = async () => { requests++; return { data: { remote: { type: 'running' } } }; };
  const unfinished = { id: 'orphan', time: { busy: 20, idle: 10 } };
  const [orphan, remote, idle] = await api._withActivity([
    unfinished, { ...unfinished, id: 'remote' }, { id: 'idle', time: { idle: 30 } },
  ]);
  assert.equal(sessionActivity(orphan), 'unconfirmed', 'shutdown intent is not live execution');
  assert.equal(isBusy(orphan), false, 'sidebar must not spin for unconfirmed execution');
  assert.equal(isBusy(remote), true);
  assert.equal(sessionActivity(idle), 'idle');
  api.setSessionRunning('orphan', 'tab1', true);
  api.setSessionRunning('orphan', 'tab2', true);
  api.setSessionRunning('orphan', 'tab1', false);
  assert.equal(sessionActivity((await api._withActivity([unfinished]))[0]), 'running', 'another local owner remains active');
  api.setSessionRunning('orphan', 'tab2', false);
  assert.equal(sessionActivity((await api._withActivity([unfinished]))[0]), 'unconfirmed');
  assert.equal(requests, 1, 'sidebar and tabs share one live activity snapshot');
  api._activeRead = null;
  api._request = async () => { throw new Error('offline'); };
  assert.equal(sessionActivity((await api._withActivity([unfinished]))[0]), 'unconfirmed', 'an unavailable owner is not completion');

  const { panel, messages } = fixture();
  await panel._refreshServerStatus();
  assert.equal(panel._busy, true, 'opening a running session adopts server state');
  assert.equal(panel._externalTurn, true);
  assert.equal(messages[0].state, 'busy');
  assert.equal(messages[0].external, true, 'do not invent a live activity timer for an external turn');
  await panel._refreshServerStatus();
  assert.equal(messages.length, 1, 'polling must not restart the activity timer');
  panel.deps.api.getSession = async () => { throw new Error('offline'); };
  await panel._refreshServerStatus();
  assert.equal(panel._busy, true, 'a failed poll is not completion');
  panel.deps.api.getSession = async () => ({ time: { busy: 20, idle: 30 } });
  await panel._refreshServerStatus();
  assert.equal(panel._busy, false);
  assert.deepEqual(messages.slice(1), [{ type: 'reload' }, { type: 'status', state: 'ready' }]);

  const suspended = fixture();
  suspended.panel.deps.api.getSession = async () => unfinished;
  await suspended.panel._refreshServerStatus();
  assert.equal(suspended.panel._busy, false, 'unfinished intent must not force new messages into the shared-server queue');
  assert.equal(suspended.messages[0].state, 'unconfirmed');
  await suspended.panel._refreshServerStatus();
  assert.equal(suspended.messages.length, 1, 'stable uncertainty does not repeatedly reset the UI');
  suspended.panel.deps.api.getSession = async () => ({ ...unfinished, _activity: 'running' });
  await suspended.panel._refreshServerStatus();
  assert.equal(suspended.panel._busy, true, 'a subsequently confirmed recovery becomes working');
  suspended.panel.deps.api.getSession = async () => unfinished;
  await suspended.panel._refreshServerStatus();
  assert.equal(suspended.panel._busy, false);
  assert.equal(suspended.messages.at(-1).state, 'unconfirmed', 'loss of ownership is not successful completion');
  assert.equal(suspended.messages.at(-2).type, 'reload');

  const owned = fixture();
  const ownership = [];
  owned.panel.deps.api.setSessionRunning = (...args) => ownership.push(args);
  owned.panel._startTurn();
  owned.panel._finishTurn('ready');
  assert.deepEqual(ownership.map(([id, owner, running]) => [id, owner === owned.panel, running]),
    [['session', true, true], ['session', true, false]]);

  const initialIdle = fixture();
  initialIdle.panel.deps.api.getSession = async () => ({ time: { busy: 10, idle: 20 } });
  initialIdle.panel._finishTurn = () => assert.fail('initial idle must not mark an inactive tab as newly completed');
  await initialIdle.panel._refreshServerStatus();

  const recovery = fixture();
  const token = { sessionID: 'session', turn: 'interrupted' };
  const completed = [];
  let submitted;
  let submitOptions;
  recovery.panel.deps.continuations = {
    claim: () => token, complete: (value) => completed.push(value),
    begin: () => assert.fail('a recovered turn keeps its original intent token'),
  };
  recovery.panel.deps.api.getSession = async () => ({ id: 'session', time: { busy: 20, idle: 10 } });
  recovery.panel._client = { shared: true, reconcile: async () => {}, prompt: async (blocks, options) => {
    submitted = blocks;
    submitOptions = options;
    return { stopReason: 'end_turn' };
  } };
  await recovery.panel._refreshServerStatus();
  await Promise.resolve();
  assert.ok(submitted[0].text.startsWith(CONTINUE_TEXT));
  assert.equal(submitOptions.synthetic, true, 'resume uses the server synthetic endpoint, not a visible user message');
  assert.deepEqual(completed, [], 'durable admission does not complete a continuation');
  recovery.panel._onServerActivity('running');
  recovery.panel._onServerActivity('idle');
  assert.deepEqual(completed, [token]);
  assert.equal(recovery.panel._busy, false);

  const stopping = fixture();
  stopping.panel._busy = true;
  stopping.panel._continuation = token;
  stopping.panel._elicitations = new Map();
  stopping.panel._refreshAttention = () => {};
  stopping.panel.deps.continuations = { complete: (value) => completed.push(value) };
  stopping.panel._client.cancel = () => assert.equal(completed.at(-1), token, 'persist Stop before cancelling ACP');
  stopping.panel._cancel();
  assert.equal(stopping.panel._continuation, null);

  let remoteStopped;
  stopping.panel._externalTurn = true;
  stopping.panel._client.cancel = () => assert.fail('Stop must target the runtime that owns the external turn');
  stopping.panel.deps.api.interruptSession = async (id) => { remoteStopped = id; };
  stopping.panel._cancel();
  assert.equal(remoteStopped, 'session');

  const lostConnection = fixture();
  lostConnection.panel._continuation = token;
  lostConnection.panel.deps.continuations = { complete: () => assert.fail('lost connection must preserve recovery intent') };
  lostConnection.panel._finishTurn('error');
  assert.equal(lostConnection.panel._continuation, token);

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

  const archived = fixture();
  archived.panel._archived = true;
  archived.panel.deps.api.runCommand = () => assert.fail('archived tabs cannot run commands');
  archived.panel._client.prompt = () => assert.fail('archived tabs cannot send prompts');
  await archived.panel._runCommand('review', '');
  await archived.panel._prompt('message', [], null);

  const disposed = fixture();
  disposed.panel.deps.api.getSession = () => new Promise((done) => { resolve = done; });
  const pending = disposed.panel._refreshServerStatus();
  disposed.panel._disposed = true;
  resolve({ time: { busy: 20 } });
  await pending;
  assert.equal(disposed.messages.length, 0);
  console.log('Session status tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

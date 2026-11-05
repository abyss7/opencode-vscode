'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SessionContinuation } = require('../src/session-continuation');

const root = fs.mkdtempSync(path.join(process.env.OUT || os.tmpdir(), 'continuation-test-'));
try {
  let now = 1000;
  const alive = new Set([101, 102, 103]);
  const options = { isAlive: (pid) => alive.has(pid), now: () => now };
  const first = new SessionContinuation(root, options);
  const second = new SessionContinuation(root, options);
  const session = { id: 'ses_recovery', time: { busy: 1100, idle: 900 }, outcome: 'succeeded', _activity: 'unconfirmed' };
  const token = first.begin(session.id, 101);
  assert.equal(first.claim(session, 102), null, 'never steal a live ACP turn');
  alive.delete(101);
  assert.equal(first.claim(session, 102), null, 'allow standalone shutdown to settle');
  assert.equal(second.claim(session, 103), null);
  now += 3000;
  assert.deepEqual(first.claim(session, 102), token, 'success from a previous idle period must not hide an interrupted newer turn');
  assert.equal(second.claim(session, 103), null, 'another window sees the atomically claimed owner');
  alive.delete(102);
  assert.equal(second.claim(session, 103), null);
  now += 3000;
  assert.deepEqual(second.claim(session, 103), token, 'an interrupted recovery is itself recoverable');
  second.complete(token);
  alive.delete(103);
  now += 3000;
  assert.equal(first.claim(session, 101), null, 'Stop or completion permanently terminalizes this turn');

  const next = first.begin(session.id, 104);
  first.complete(token);
  session.time.busy = now + 1;
  assert.equal(second.claim(session, 105), null);
  now += 3000;
  assert.deepEqual(second.claim(session, 105), next, 'old cleanup cannot discard a newer turn');

  const stopped = first.begin('ses_stopped', 106);
  second.stop(stopped.sessionID);
  assert.equal(first.claim({ ...session, id: 'ses_stopped' }, 107), null);
  assert.equal(first.claim({ ...session, id: 'ses_untracked' }, 107), null, 'no recovery inferred from busy alone');
  first.begin('ses_finished', 108);
  assert.equal(first.claim({ id: 'ses_finished', time: { busy: now + 1, idle: now + 2 }, outcome: 'succeeded' }, 109), null,
    'server completion prevents replay even when the editor missed its final callback');
  first.begin('ses_remote', 110);
  assert.equal(first.claim({ id: 'ses_remote', time: { busy: now + 1 }, _activity: 'running' }, 111), null);
  const interrupted = first.begin('ses_closed', 112);
  const closed = { id: 'ses_closed', time: { busy: now + 1, idle: now + 2 }, outcome: 'interrupted' };
  assert.equal(first.claim(closed, 113), null);
  now += 3000;
  assert.deepEqual(first.claim(closed, 113), interrupted, 'ACP wind-down interruption is recoverable without a Stop tombstone');
  console.log('Session continuation tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

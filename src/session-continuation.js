'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const CONTINUE_TEXT = 'The editor closed while you were working. Continue from where you left off without repeating completed work. Inspect the results of interrupted tools before deciding whether they need to be run again.';
const ID = /^[a-f0-9-]{36}$/;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Only turns started by this extension are recoverable. Immutable ownership
// links coordinate separate windows without treating durable busy as a lease.
// A dead owner can have exactly one successor; no stale-lock deletion race.
class SessionContinuation {
  constructor(root, options = {}) {
    this.root = root;
    this.isAlive = options.isAlive || isAlive;
    this.now = options.now || Date.now;
    this.deadSince = new Map();
  }

  _directory(sessionID) {
    return path.join(this.root, createHash('sha256').update(sessionID).digest('hex'));
  }

  _read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  _write(file, value, exclusive = false) {
    const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      if (exclusive) fs.linkSync(temp, file);
      else fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  begin(sessionID, pid) {
    if (!this.root || !Number.isInteger(pid) || pid <= 0) return null;
    const directory = this._directory(sessionID);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const token = { sessionID, turn: randomUUID(), started: this.now() };
    this._write(path.join(directory, `${token.turn}.json`), { pid, next: randomUUID() }, true);
    this._write(path.join(directory, 'current.json'), token);
    return token;
  }

  complete(token) {
    if (!token || !this.root) return;
    // Terminalize this turn, never a newer turn started in another window.
    fs.writeFileSync(path.join(this._directory(token.sessionID), `${token.turn}.done`), '', { mode: 0o600 });
  }

  stop(sessionID) {
    if (!this.root) return;
    const token = this._read(path.join(this._directory(sessionID), 'current.json'));
    if (token?.sessionID === sessionID && ID.test(token.turn)) this.complete(token);
  }

  claim(session, pid) {
    if (!this.root || !Number.isInteger(pid) || pid <= 0) return null;
    const directory = this._directory(session.id);
    const token = this._read(path.join(directory, 'current.json'));
    if (!token || token.sessionID !== session.id || !ID.test(token.turn)) return null;
    if (fs.existsSync(path.join(directory, `${token.turn}.done`))) return null;
    const time = session.time || {};
    // ACP may publish a normal interrupted terminal while winding down its
    // connection. Our own Stop tombstone distinguishes that from window close.
    const finished = time.idle && time.idle >= time.busy && session.outcome !== 'interrupted';
    if (!time.busy || time.busy < token.started || finished) {
      this.complete(token);
      return null;
    }
    if (session._activity === 'running') return null;

    let link = token.turn;
    let lastDeadAt = this.now();
    for (let attempt = 0; attempt < 100; attempt++) {
      const file = path.join(directory, `${link}.json`);
      const owner = this._read(file);
      if (owner) {
        if (!Number.isInteger(owner.pid) || !ID.test(owner.next)) return null;
        if (this.isAlive(owner.pid)) return null;
        if (!this.deadSince.has(file)) this.deadSince.set(file, this.now());
        lastDeadAt = this.deadSince.get(file);
        link = owner.next;
        continue;
      }
      // ACP's standalone server has a three-second shutdown grace period.
      // Wait after observing its parent exit, not after a lack of model output.
      if (this.now() - lastDeadAt < 3000) return null;
      try {
        this._write(file, { pid, next: randomUUID() }, true);
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Another window won. Read that immutable owner on the next iteration.
      }
    }
    return null;
  }
}

module.exports = { SessionContinuation, CONTINUE_TEXT };

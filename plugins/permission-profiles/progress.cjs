'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const identity = (stat) => `${stat.dev}:${stat.ino}`;

// Portable file transport, independent of discovery. A separate open description
// and positional reads must never change the writer's offset. O_NONBLOCK and a
// second type check protect against a regular-file -> pipe race at open time.
async function readRegularFile(file, previous = {}, limit = 262144) {
  const before = await fsp.stat(file);
  if (!before.isFile()) return null;
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || identity(stat) !== identity(before)) return null;
    const fileIdentity = identity(stat);
    const reset = previous.identity !== undefined && previous.identity !== fileIdentity || previous.cursor > stat.size;
    const start = reset ? 0 : Math.max(0, Number.isSafeInteger(previous.cursor) ? previous.cursor : 0);
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - start)));
    const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, start) : { bytesRead: 0 };
    return { identity: fileIdentity, reset, cursor: start + bytesRead, size: stat.size,
      data: buffer.subarray(0, bytesRead).toString('base64') };
  } finally { await handle.close(); }
}

function createObserver({ platform = process.platform, procRoot = '/proc', ownerPID = process.pid } = {}) {
  const roots = new Map();
  const supported = platform === 'linux';
  const file = (pid, suffix) => path.join(procRoot, String(pid), suffix);
  const processInfo = async (pid) => {
    try {
      const stat = await fsp.readFile(file(pid, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[0] === 'Z' || !/^\d+$/.test(fields[19] || '')) return null;
      return { pid, parent: Number(fields[1]), id: `${pid}:${fields[19]}` };
    } catch { return null; }
  };
  const owned = async (root) => {
    if (root.pid === ownerPID) return false;
    const seen = new Set();
    let parent = root.parent;
    while (parent > 0 && !seen.has(parent) && seen.size < 64) {
      if (parent === ownerPID) return true;
      seen.add(parent);
      const info = await processInfo(parent);
      if (!info) return false;
      parent = info.parent;
    }
    return false;
  };

  return {
    async observe(input) {
      if (!supported) return { supported: false, sources: [] };
      const { pid, sessionID, shellID, executables, states = [] } = input;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !/^ses_[\w-]+$/.test(sessionID || '') ||
          !/^sh_[\w-]+$/.test(shellID || '') || !Array.isArray(executables) || !executables.length || executables.length > 32 ||
          executables.some((name) => typeof name !== 'string' || !/^[\w.+-]+$/.test(name)) ||
          !Array.isArray(states) || states.length > 8 || states.some((state) => !Number.isSafeInteger(state.cursor) || state.cursor < 0)) {
        throw new Error('Invalid command progress observation');
      }
      const empty = { supported: true, sources: [] };
      const root = await processInfo(pid);
      if (!root || !await owned(root)) return empty;
      const key = `${sessionID}/${shellID}`;
      const previousRoot = roots.get(key);
      if (previousRoot && previousRoot !== root.id) return empty; // PID reuse is not a new execution.
      roots.delete(key); roots.set(key, root.id);
      if (roots.size > 1024) roots.delete(roots.keys().next().value);

      const queue = [root], seen = new Set(), matches = [];
      // Only inspect this shell's descendants. Never scan all host processes.
      for (let index = 0; index < queue.length && index < 1024; index++) {
        const current = queue[index];
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        try {
          const executable = path.basename(await fsp.readlink(file(current.pid, 'exe'))).replace(/ \(deleted\)$/, '');
          if (executables.includes(executable)) matches.push(current);
          const children = await fsp.readFile(file(current.pid, `task/${current.pid}/children`), 'utf8');
          for (const value of children.trim().split(/\s+/)) {
            const childPID = Number(value);
            if (!Number.isSafeInteger(childPID) || childPID <= 0 || queue.length >= 1024) continue;
            const child = await processInfo(childPID);
            if (child?.parent === current.pid) queue.push(child);
          }
        } catch { /* A process can exit at any point during observation. */ }
      }
      // A single inline bar cannot attribute interleaved output from concurrent
      // matching executables. Do not guess which process a record belongs to.
      if (matches.length !== 1) return empty;
      const target = matches[0];
      const sources = [], files = new Set();
      let capture = false;
      for (const fd of [1, 2]) {
        try {
          const descriptor = file(target.pid, `fd/${fd}`);
          const stat = await fsp.stat(descriptor);
          if (stat.isFile()) {
            const id = `${target.id}/file/${identity(stat)}`;
            if (files.has(id)) continue;
            files.add(id);
            const state = states.find((state) => state.id === id);
            const chunk = await readRegularFile(descriptor, state);
            if (chunk) sources.push({ id, kind: 'file', ...chunk });
          } else if (stat.isFIFO() || stat.isSocket()) capture = true;
          else if (stat.isCharacterDevice()) {
            const destination = await fsp.readlink(descriptor);
            if (/^\/dev\/(pts\/|tty)/.test(destination)) capture = true;
          }
        } catch { /* Unavailable descriptors are not alternate log paths. */ }
      }
      if (capture) sources.push({ id: `${target.id}/capture`, kind: 'capture' });
      if ((await processInfo(pid))?.id !== root.id || (await processInfo(target.pid))?.id !== target.id) return empty;
      return { supported: true, sources };
    },
    dispose() { roots.clear(); },
  };
}

module.exports = { createObserver, readRegularFile };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });
const result = async (run) => {
  try { return await run(); }
  catch (error) { return { error: { code: error.code || 'permission_error', message: error.message } }; }
};

function sessionID(input) {
  if (!/^ses_[\w-]+$/.test(input.sessionID)) throw new Error('Invalid session ID');
  if (typeof input.toolCallId !== 'string' || !input.toolCallId) throw new Error('Missing tool call ID');
  return /^ses_[\w-]+:/.exec(input.toolCallId)?.[0].slice(0, -1) || input.sessionID;
}

function request(socketPath, method, input) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => finish(failure('unavailable', 'The permission owner did not respond.')));
    socket.on('error', () => finish(failure('unavailable', 'The permission owner is no longer connected.')));
    socket.on('end', () => finish(failure('unavailable', 'The permission owner closed the connection.')));
    socket.on('connect', () => socket.write(JSON.stringify({ method, input }) + '\n'));
    socket.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BYTES) return finish(failure('invalid_reply', 'Permission details are too large.'));
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, end));
        finish(value.error ? failure(value.error.code, value.error.message) : null, value);
      } catch (error) { finish(error); }
    });
  });
}

// ACP owns a standalone server. Route only pending-request operations to its
// plugin instance; keep credentials and permission payloads out of discovery files.
function createBridge(root, handlers) {
  const id = randomUUID();
  const files = new Set();
  const sockets = new Set();
  let server;
  let directory;
  let address;
  let starting;
  let closed = false;
  const ownerFile = (session, owner) => path.join(root, 'owners', session, `${owner}.json`);
  const start = () => {
    if (!starting) starting = (async () => {
      if (closed) throw new Error('Permission bridge is closed');
      if (process.platform === 'win32') address = `\\\\.\\pipe\\opencode-permissions-${id}`;
      else {
        const base = fs.existsSync('/place/vartmp/opencode') ? '/place/vartmp/opencode' : os.tmpdir();
        directory = fs.mkdtempSync(path.join(base, 'oc-permissions-'));
        fs.chmodSync(directory, 0o700);
        address = path.join(directory, 'rpc.sock');
      }
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setEncoding('utf8');
        socket.setTimeout(10000, () => socket.destroy());
        let buffer = '';
        let size = 0;
        let received = false;
        socket.on('data', async (chunk) => {
          if (received) return;
          size += Buffer.byteLength(chunk);
          if (size > MAX_BYTES) { received = true; socket.destroy(); return; }
          buffer += chunk;
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          received = true;
          const value = await result(async () => {
            const { method, input } = JSON.parse(buffer.slice(0, end));
            if (!['describe', 'remember'].includes(method)) throw new Error('Unsupported permission operation');
            return handlers[method](input);
          });
          if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, () => { server.removeListener('error', reject); resolve(); });
      });
      server.on('error', () => {});
      server.unref();
      if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
    })();
    return starting;
  };
  const owners = (session) => {
    const dir = path.join(root, 'owners', session);
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name) && name !== `${id}.json`).flatMap((name) => {
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        return owner.id === name.slice(0, -5) && typeof owner.socket === 'string' ? [owner] : [];
      } catch { return []; }
    });
  };
  return {
    id,
    async register(session) {
      if (!/^ses_[\w-]+$/.test(session)) throw new Error('Invalid session ID');
      await start();
      if (closed) throw new Error('Permission bridge is closed');
      const target = ownerFile(session, id);
      if (files.has(target)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ id, socket: address }), { mode: 0o600 });
      fs.renameSync(temp, target);
      files.add(target);
    },
    async describe(input) {
      const replies = await Promise.allSettled(owners(sessionID(input)).map((owner) => request(owner.socket, 'describe', input)));
      const matches = replies.filter((item) => item.status === 'fulfilled');
      if (matches.length === 1) return matches[0].value;
      if (matches.length > 1) throw failure('ambiguous', 'More than one runtime owns this request. Please retry the operation.');
      const error = replies.find((item) => item.status === 'rejected' && !['unavailable', 'not_pending'].includes(item.reason.code));
      if (error) throw error.reason;
      throw failure('not_pending', 'This permission request is no longer pending, or its runtime has disconnected.');
    },
    async remember(input) {
      const owner = owners(sessionID(input)).find((item) => item.id === input.owner);
      if (!owner) throw failure('not_pending', 'The permission owner is no longer connected. Please retry the operation.');
      return request(owner.socket, 'remember', input);
    },
    async dispose() {
      closed = true;
      if (starting) await starting.catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      for (const file of files) {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { fs.rmdirSync(path.dirname(file)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
      }
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

module.exports = { createBridge, result, failure };

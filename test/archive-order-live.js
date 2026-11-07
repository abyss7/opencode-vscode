'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'archive-order-'));
const config = path.join(base, 'config');
const cwd = path.join(base, 'workspace');
const entered = path.join(base, 'entered.json');
const release = path.join(base, 'release');
fs.mkdirSync(cwd);
process.env.OPENCODE_CONFIG_DIR = config;
const { ArchiveService } = require('../src/archive-service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let child;
  let exited;
  let request;
  let sessionID;
  try {
    await new ArchiveService({ command: 'opencode', api: {}, log() {} }).install();
    const hookDir = path.join(config, 'plugins', 'barrier-hook');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'index.ts'), `
import { Plugin } from '@opencode/plugin'
import { ArchiveHook } from '../vscode-archive/hook.js'
import fs from 'node:fs/promises'
let calls = 0
export default Plugin.define({ id: 'barrier-hook', async setup(ctx) {
  const registration = await ctx.rpc.register(ArchiveHook, { async afterArchive(input) {
    calls += 1
    const page = await ctx.session.list({ directory: ctx.location.directory, archived: true, limit: 200 })
    const sessions = Array.isArray(page) ? page : page.data || []
    const session = sessions.find((item) => item.id === input.sessionID)
    await fs.writeFile(${JSON.stringify(entered)}, JSON.stringify({ calls, archivedAt: session?.time?.archived, input }))
    while (!(await fs.stat(${JSON.stringify(release)}).then(() => true, () => false))) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return {}
  } })
  return () => registration.dispose()
} })
`);

    const password = randomBytes(32).toString('base64url');
    child = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
      cwd,
      env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_CLIENT: 'archive-order-test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    exited = new Promise((resolve) => child.once('exit', resolve));
    const url = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 20000);
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const data = JSON.parse(line);
            if (data.url) {
              clearTimeout(timer);
              resolve(data.url);
            }
          } catch {}
        }
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Server exited early: ${stderr}`)));
    });
    request = async (method, route, body) => {
      const response = await fetch(new URL(route, url), {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const value = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(`${response.status} ${text}`);
      return value;
    };
    const rpc = (method, input) => request('POST',
      `/api/rpc/vscode-archive/${method}?location[directory]=${encodeURIComponent(cwd)}`, { input });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((await rpc('status', {})).output.version === 3) break;
      } catch {}
      if (attempt === 39) throw new Error('Archive RPC did not become available.');
      await sleep(100);
    }
    sessionID = (await request('POST', '/api/session', {
      title: 'Archive ordering barrier', location: { directory: cwd },
    })).data.id;
    await request('PATCH', `/api/session/${sessionID}`, { archived: true });

    const startedAt = Date.now();
    const started = (await rpc('afterArchive', { sessionID })).output.finalization;
    assert.equal(started.state, 'pending');
    assert.ok(Date.now() - startedAt < 2000, 'starting finalization waited for the hook');
    for (let attempt = 0; !fs.existsSync(entered) && attempt < 100; attempt += 1) await sleep(20);
    const observation = JSON.parse(fs.readFileSync(entered, 'utf8'));
    assert.equal(observation.archivedAt, started.archivedAt,
      'the hook ran before the archived session was visible');
    assert.equal(observation.input.archivedAt, started.archivedAt);
    assert.equal((await rpc('status', { sessionID })).output.finalization.state, 'pending');

    await rpc('afterArchive', { sessionID });
    await sleep(50);
    assert.equal(JSON.parse(fs.readFileSync(entered, 'utf8')).calls, 1,
      'the same archive generation ran its hook twice');
    fs.writeFileSync(release, 'ok');
    let state;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      state = (await rpc('status', { sessionID })).output.finalization;
      if (state.state !== 'pending') break;
      await sleep(20);
    }
    assert.equal(state.state, 'succeeded');
    console.log('ARCHIVE ORDER LIVE OK');
  } finally {
    if (sessionID && request) {
      try { await request('DELETE', `/api/session/${sessionID}`); } catch {}
    }
    if (child && child.exitCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

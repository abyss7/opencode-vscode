'use strict';

// Isolated server, synthetic shell and copied sleep executable. No model calls,
// actual builds, global config changes or access to another agent's execution.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { PermissionService } = require('../src/permission-service');
const { CommandProgress } = require('../src/command-progress');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== 'linux') { console.log('Progress sources live: Linux-only observer skipped'); return; }
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-progress-live-'));
  const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
  process.env.OPENCODE_CONFIG_DIR = config;
  await fs.mkdir(cwd);
  let server, exited, request, sessionID, shellID;
  try {
    await new PermissionService({ command: 'opencode', api: {}, log() {} }).install();
    const password = randomBytes(32).toString('base64url');
    server = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
      cwd, env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_CLIENT: 'progress-test' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    exited = new Promise((resolve) => server.once('exit', resolve));
    const url = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Progress test server startup timed out')), 20000);
      server.stdout.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const info = JSON.parse(line);
            if (info.url) { clearTimeout(timer); resolve(info.url); }
          } catch {}
        }
      });
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Progress test server exited before startup')); });
    });
    request = async (method, route, body) => {
      const response = await fetch(new URL(route, url), {
        method, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
          'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(`Progress test HTTP ${response.status}`);
      return value;
    };
    const location = `location[directory]=${encodeURIComponent(cwd)}`;
    const rpc = async (method, input) => {
      const value = (await request('POST', `/api/rpc/vscode-permission-profiles/${method}?${location}`, { input })).output;
      if (value?.error) throw new Error(value.error.message);
      return value;
    };
    for (let attempt = 0; ; attempt++) {
      try { await rpc('status', {}); break; }
      catch (error) { if (attempt >= 40) throw error; await wait(100); }
    }
    sessionID = (await request('POST', '/api/session', { title: 'Progress source integration', location: { directory: cwd } })).data.id;
    const executable = path.join(cwd, 'ninja'), log = path.join(cwd, 'build.log');
    await fs.copyFile('/bin/sleep', executable); await fs.chmod(executable, 0o700);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `printf '[1/192] CXX first\\n' >${quote(log)}; ${quote(executable)} 4 >>${quote(log)} 2>&1; printf '[10/192] stale head\\n'; sleep 60`;
    const shell = (await request('POST', `/api/shell?${location}`, { command, cwd, metadata: { sessionID } })).data;
    shellID = shell.id;
    assert.ok(Number.isSafeInteger(shell.pid), 'native shell API exposes its actual PID');
    const input = { sessionID, shellID, pid: shell.pid, executables: ['ninja'], states: [] };
    const client = new CommandProgress({ _request: request, permissionProfiles: rpc });
    const part = { type: 'tool', id: 'build', name: 'shell', state: { status: 'running', input: { command }, metadata: {} } };
    const messages = [{ type: 'assistant', content: [part] }];
    let observation;
    for (let attempt = 0; attempt < 30; attempt++) {
      observation = await rpc('progress', input);
      if (observation.sources.length) break;
      await wait(50);
    }
    assert.equal(observation.supported, true);
    assert.equal(observation.sources[0]?.kind, 'file', 'real native child belongs to plugin server and has a file source');
    assert.equal(Buffer.from(observation.sources[0].data, 'base64').toString(), '[1/192] CXX first\n');
    assert.equal((await client.refresh(sessionID, cwd, messages)).items[0].completed, 1);
    input.states = observation.sources;
    await fs.appendFile(log, '[2/192] CXX second\n');
    observation = await rpc('progress', input);
    assert.equal(Buffer.from(observation.sources[0].data, 'base64').toString(), '[2/192] CXX second\n');
    part.state.status = 'completed'; part.state.metadata.shellID = shellID;
    const runs = [{ toolCallId: part.id, status: 'running' }];
    assert.equal((await client.refresh(sessionID, cwd, messages, runs)).items[0].completed, 2, 'background handoff retains real file progress');
    for (let attempt = 0; observation.sources.length && attempt < 100; attempt++) {
      await wait(50); observation = await rpc('progress', input);
    }
    assert.deepEqual(observation.sources, [], 'real Ninja exit removes progress before outer shell completion');
    assert.deepEqual((await client.refresh(sessionID, cwd, messages, runs)).items, [], 'client removes the bar during subsequent tests');
    assert.equal((await request('GET', `/api/shell/${shellID}?${location}`)).data.status, 'running');
    let output = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      output = (await request('GET', `/api/shell/${shellID}/output?${location}`)).data.output;
      if (output.includes('[10/192] stale head')) break;
      await wait(50);
    }
    assert.ok(output.includes('[10/192] stale head'), 'head-like replay is present but is not a progress source');
    console.log('Progress sources live: native shell PID, server-side RPC, redirected file, incremental read and child exit passed');
  } finally {
    if (shellID && request) { try { await request('DELETE', `/api/shell/${shellID}`); } catch {} }
    if (sessionID && request) { try { await request('DELETE', `/api/session/${sessionID}`); } catch {} }
    if (server && server.exitCode === null) {
      server.stdin.end(); const timer = setTimeout(() => server.kill('SIGTERM'), 5000);
      await exited; clearTimeout(timer);
    }
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

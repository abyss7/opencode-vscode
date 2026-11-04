'use strict';

// Opt-in: starts one standalone OpenCode server, creates/deletes one test session,
// and exercises synthetic permissions. No model generation or tool execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { OpenCodeApi } = require('../src/api');
const { PermissionService } = require('../src/permission-service');
const { VERSION } = require('../src/permission-profiles');

async function main() {
  if (process.env.OPENCODE_PERMISSION_LIVE !== '1') throw new Error('Set OPENCODE_PERMISSION_LIVE=1 only after approving this live test.');
  const base = fs.existsSync('/place/vartmp/opencode') ? '/place/vartmp/opencode' : os.tmpdir();
  const cwd = fs.mkdtempSync(path.join(base, 'permission-live-'));
  const command = process.env.OPENCODE_COMMAND || 'opencode';
  const api = new OpenCodeApi({ command });
  const service = new PermissionService({ vscode: {}, api, command, log: () => {} });
  let child;
  let exited;
  let session;
  let native;
  let installation;
  try {
    installation = await service.install();
    await service.ready(cwd);
    // Match ACP's Standalone.start(): random port, private password and an EOF lease.
    // The password exists only in memory/the child environment, never in logs/files.
    const password = randomBytes(32).toString('base64url');
    child = spawn(command, ['serve', '--stdio', '--port', '0'], {
      cwd, env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_CLIENT: 'acp' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    exited = new Promise((resolve) => child.once('exit', resolve));
    const url = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Standalone server did not start')), 20000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Standalone server exited before readiness')); });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const ready = JSON.parse(line);
            if (ready.url) { clearTimeout(timer); resolve(ready.url); }
          } catch { /* Ignore non-readiness lines; keep stdout drained. */ }
        }
      });
    });
    native = async (method, route, body) => {
      const response = await fetch(new URL(route, url), {
        method, signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const value = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(`Native API ${method} ${route}: ${response.status} ${value?.message || ''}`);
      return value;
    };
    // A real ACP turn activates plugins before tools run. Synthetic permission
    // endpoints alone do not await activation; RPC does so explicitly.
    const query = new URLSearchParams({ 'location[directory]': cwd });
    assert.equal((await native('POST', `/api/rpc/vscode-permission-profiles/status?${query}`, { input: {} })).output.version, VERSION);
    session = (await native('POST', '/api/session', {
      title: 'Permission bridge smoke test (temporary)', agent: 'build', location: { directory: cwd },
      // Isolate the plugin under test from host-specific native agent defaults.
      // This session never generates model output or executes a command.
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    })).data.id;
    await api.permissionProfiles('configure', {
      sessionID: session, layers: [], defaultProfile: 'workspace', newActions: 'ask',
    }, cwd);

    const ask = async (id, resource) => (await native('POST', `/api/session/${session}/permission`, {
      action: 'shell', resources: [resource], source: { type: 'tool', messageID: 'permission_bridge_probe', id },
    })).data;
    const request = await ask('call_bridge_allow', 'echo bridge-smoke *');
    assert.equal(request.effect, 'ask', 'initial synthetic permission must reach the plugin Ask rule');
    const description = await service.describe(session, cwd, 'call_bridge_allow');
    assert.equal(description.permissionId, request.id);
    assert.ok(description.owner);
    await service.remember(session, cwd, 'call_bridge_allow', description, 'exact', 'allow');
    await native('POST', `/api/session/${session}/permission/${request.id}/reply`, { decision: 'once' });
    assert.equal((await ask('call_bridge_allowed', 'echo bridge-smoke *')).effect, 'allow');
    await assert.rejects(() => service.describe(session, cwd, 'call_bridge_allow'), /no longer pending/);

    const denied = await ask('call_bridge_deny', 'echo bridge-smoke forbidden');
    assert.equal(denied.effect, 'ask', 'a different command must still ask after saving an exact allow');
    const denyDescription = await service.describe(session, cwd, 'call_bridge_deny');
    await service.remember(session, cwd, 'call_bridge_deny', denyDescription, 'exact', 'deny');
    await native('POST', `/api/session/${session}/permission/${denied.id}/reply`, { decision: 'reject' });
    assert.equal((await ask('call_bridge_forbidden', 'echo bridge-smoke forbidden')).effect, 'deny');
    const document = JSON.parse(fs.readFileSync(path.join(cwd, '.opencode/permission-rules.json'), 'utf8'));
    assert.deepEqual(document.profiles.workspace.rules.map((rule) => rule.effect), ['allow', 'deny']);
    console.log('LIVE PERMISSION BRIDGE OK: shared RPC → standalone pending request → saved Allow/Forbid → native enforcement');
  } finally {
    try {
      if (session && native) await native('DELETE', `/api/session/${session}`);
    } finally {
      if (child && child.exitCode === null) {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
        await exited;
        clearTimeout(timer);
      }
      if (session && installation) fs.rmSync(path.join(installation, 'state', `${session}.json`), { force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

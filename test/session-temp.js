'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionService } = require('../src/permission-service');

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-session-temp-')));
  let dispose;
  try {
    const plugin = path.join(temp, 'plugin');
    fs.mkdirSync(plugin);
    fs.copyFileSync(path.join(__dirname, '../src/permission-profiles.js'), path.join(plugin, 'engine.cjs'));
    fs.copyFileSync(path.join(__dirname, '../plugins/permission-profiles/session-temp.cjs'), path.join(plugin, 'session-temp.cjs'));
    const { createManager, resolveBase, defaultStateBase } = require(path.join(plugin, 'session-temp.cjs'));
    const manager = createManager(temp);
    const originalXdgState = process.env.XDG_STATE_HOME;
    try {
      delete process.env.XDG_STATE_HOME;
      if (process.platform === 'linux') {
        assert.equal(defaultStateBase(), path.join(os.homedir(), '.local', 'state'));
      }
      assert.notEqual(resolveBase(''), fs.realpathSync(os.tmpdir()), 'session scratch files live in persistent user state, not /tmp');
      assert.equal(createManager().directory('ses_default'), path.join(resolveBase(''), 'opencode', 'sessions', 'ses_default'));
      const xdgState = path.join(temp, 'xdg-state');
      process.env.XDG_STATE_HOME = xdgState;
      assert.equal(resolveBase(''), xdgState);
      assert.equal(createManager().directory('ses_default'), path.join(xdgState, 'opencode', 'sessions', 'ses_default'));
    } finally {
      if (originalXdgState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalXdgState;
    }
    assert.equal(resolveBase('~/scratch'), path.join(fs.realpathSync(os.homedir()), 'scratch'));
    assert.throws(() => resolveBase('relative'), /absolute path/);
    assert.throws(() => resolveBase(false), /must be a string/);
    const a = manager.ensure('ses_a');
    const b = manager.ensure('ses_b');
    const matches = (file, action = 'edit') => manager.contains('ses_a', action, file, temp);
    assert.equal(matches(path.join(a, 'missing', 'new.py')), true);
    assert.equal(matches(path.join(a, 'out', 'log')), true);
    assert.equal(matches(path.join(b, 'new.py')), false);
    assert.equal(matches(`${a}-other/new.py`), false);
    assert.equal(matches(path.join(a, '..', 'ses_b', 'new.py')), false);
    assert.equal(matches('opencode/sessions/ses_a/new.py'), true);
    assert.equal(matches(`${a}/*`, 'external_directory'), true);
    assert.equal(matches(`${path.dirname(a)}/*`, 'external_directory'), false);
    assert.equal(matches(a, 'shell'), false);
    assert.throws(() => manager.directory('../ses_b'), /Invalid session ID/);
    assert.throws(() => manager.directory(undefined), /Invalid session ID/);
    fs.symlinkSync(b, path.join(a, 'escape'), 'dir');
    assert.equal(matches(path.join(a, 'escape', 'new.py')), false, 'canonical paths block symlink escapes');
    fs.symlinkSync(b, path.join(path.dirname(a), 'ses_link'), 'dir');
    assert.throws(() => manager.ensure('ses_link'), /symlink/);

    let contextHook;
    let shellHook;
    let disposed = 0;
    const registration = () => ({ dispose() { disposed += 1; } });
    const arrived = [];
    let release;
    const both = new Promise((resolve) => { release = resolve; });
    const tool = { execute: async (input) => {
      arrived.push(input);
      if (arrived.length === 2) release();
      await both; // Overlap both executions before asking for shell environments.
      const event = { command: input.command, cwd: temp, env: { OUT: 'old-shared-output' } };
      await shellHook(event);
      return event;
    } };
    const ctx = {
      session: { hook: async (name, callback) => {
        assert.equal(name, 'context'); contextHook = callback; return registration();
      } },
      tool: { transform: async (callback) => {
        callback({ update(name, update) { assert.equal(name, 'shell'); update(tool); } });
        return registration();
      } },
      shell: { hook: async (name, callback) => {
        assert.equal(name, 'create.before'); shellHook = callback; return registration();
      } },
    };
    let base = temp;
    dispose = await manager.register(ctx, async (id) => ['ses_a', 'ses_b'].includes(id)
      ? { sessionTempBaseDirectory: base } : undefined);
    const events = await Promise.all(['ses_a', 'ses_b'].map((sessionID) => tool.execute({ command: 'mktemp -d' }, { sessionID })));
    for (const [i, event] of events.entries()) {
      const target = i ? b : a;
      assert.equal(event.env.TMPDIR, target);
      assert.equal(event.env.TMP, target);
      assert.equal(event.env.TEMP, target);
      assert.equal(event.env.OUT, path.join(target, 'out'));
      assert.equal(event.env.OPENCODE_SESSION_ID, i ? 'ses_b' : 'ses_a');
      assert.equal(event.command, 'mktemp -d', 'command is not rewritten');
      assert.ok(fs.statSync(event.env.OUT).isDirectory());
    }
    const unowned = { env: {} };
    await shellHook(unowned);
    assert.deepEqual(unowned.env, {}, 'unrelated shells never inherit the last session');
    const unmanaged = await tool.execute({ command: 'pwd' }, { sessionID: 'ses_unmanaged' });
    assert.equal(unmanaged.env.TMPDIR, undefined);
    const context = { sessionID: 'ses_a', system: [] };
    await contextHook(context);
    assert.ok(context.system[0].text.includes(a));
    const otherContext = { sessionID: 'ses_unmanaged', system: [] };
    await contextHook(otherContext);
    assert.deepEqual(otherContext.system, []);
    base = path.join(temp, 'custom-base');
    const moved = await tool.execute({ command: 'mktemp -d' }, { sessionID: 'ses_a' });
    const movedPath = path.join(fs.realpathSync(temp), 'custom-base', 'opencode', 'sessions', 'ses_a');
    assert.equal(moved.env.TMPDIR, movedPath, 'shell follows updated base');
    const movedContext = { sessionID: 'ses_a', system: [] };
    await contextHook(movedContext);
    assert.ok(movedContext.system[0].text.includes(movedPath), 'context uses the same base as shell and permissions');
    await dispose(); dispose = null;
    assert.equal(disposed, 3);

    // The VS Code checkbox must reach the host, including an explicit false.
    let configured;
    let enabled = false;
    const service = new PermissionService({
      vscode: { Uri: { file: (file) => file }, workspace: { getConfiguration: () => ({
        inspect: () => ({}), get: (key, fallback) => key === 'allowSessionTemp' ? enabled
          : key === 'sessionTempBaseDirectory' ? base : fallback,
      }) } },
      api: { permissionProfiles: async (_, input) => { configured = input; } },
    });
    await service.configure('ses_a', temp, 'build');
    assert.equal(configured.allowSessionTemp, false);
    assert.equal(configured.sessionTempBaseDirectory, base);
    enabled = true;
    await service.configure('ses_a', temp, 'build');
    assert.equal(configured.allowSessionTemp, true);
    console.log('session temporary directories: OK');
  } finally {
    if (dispose) await dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

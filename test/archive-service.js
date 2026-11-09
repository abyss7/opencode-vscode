'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-archive-'));
process.env.OPENCODE_CONFIG_DIR = temp;

const { ArchiveService } = require('../src/archive-service');
const { setup } = require('../plugins/archive/runtime.cjs');

async function main() {
  let statusAttempts = 0;
  const apiCalls = [];
  let finalization = null;
  let releaseHook;
  const service = new ArchiveService({
    command: 'opencode',
    log: () => {},
    pollInterval: 0,
    api: {
      archiveIntegration: async (method, input, directory) => {
        if (method === 'afterArchive') {
          apiCalls.push(['rpc', input, directory]);
          finalization = { archivedAt: 123, state: 'pending' };
          return { finalization };
        }
        if (input.sessionID) {
          apiCalls.push(['status', input, directory]);
          return { version: 4, finalization };
        }
        statusAttempts += 1;
        if (statusAttempts === 1) throw new Error('reloading');
        return { version: 4 };
      },
    },
  });
  const target = await service.install();
  for (const file of ['index.ts', 'hook.ts', 'runtime.cjs', 'README.md']) {
    assert.ok(fs.statSync(path.join(target, file)).isFile(), `${file} was not installed`);
  }
  assert.match(fs.readFileSync(path.join(target, 'index.ts'), 'utf8'), /Bundle fingerprint:/);
  await service.ready('/workspace');
  assert.strictEqual(statusAttempts, 2);

  service.api.updateSession = async (...args) => { apiCalls.push(['update', ...args]); };
  const archived = await service.archive('ses_service', '/workspace');
  assert.deepStrictEqual(apiCalls, [
    ['update', 'ses_service', { archived: true }],
  ], 'the persisted archive must not wait for plugin readiness');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(apiCalls.slice(0, 2), [
    ['update', 'ses_service', { archived: true }],
    ['rpc', { sessionID: 'ses_service' }, '/workspace'],
  ], 'the after-archive hook starts only after the PATCH');
  let completed = false;
  archived.finalization.then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(completed, false, 'background finalization remains observable while its hook runs');
  finalization = { archivedAt: 123, state: 'succeeded' };
  await archived.finalization;
  assert.strictEqual(completed, true);
  service.api.archiveIntegration = async (method) => {
    if (method === 'afterArchive') throw new Error('plugin offline');
    return { version: 3 };
  };
  const fallback = await service.archive('ses_fallback', '/workspace');
  assert.deepStrictEqual(apiCalls.at(-1), ['update', 'ses_fallback', { archived: true }]);
  assert.strictEqual((await fallback.finalization).state, 'failed');

  let definition;
  let controlMethods;
  let archivedAt = 456;
  let hookCalls = 0;
  let cleanupAvailable = true;
  const events = [];
  const storage = new Map();
  const ctx = {
    command: {
      list: async () => cleanupAvailable ? [{ name: 'cleanup' }] : [],
      transform: async (edit) => {
        edit({ add: (value) => { definition = value; } });
        return { dispose() {} };
      },
    },
    rpc: Object.assign(() => ({ afterArchive: async (input) => {
      hookCalls += 1;
      events.push(['hook', input]);
      await new Promise((resolve) => { releaseHook = resolve; });
    } }), { register: async (_, methods) => { controlMethods = methods; return { dispose() {} }; } }),
    session: {
      command: async (input) => { events.push(['cleanup', input]); },
      get: async () => ({ id: 'ses_test', time: {}, location: { directory: '/workspace' } }),
      list: async () => ({ data: archivedAt ? [{ id: 'ses_test', time: { archived: archivedAt } }] : [], cursor: {} }),
      update: async (input) => { events.push(['update', input]); archivedAt = 456; },
      wait: async (input) => { events.push(['wait', input]); },
    },
    storage: {
      get: async (key) => structuredClone(storage.get(key)),
      set: async (key, value) => { storage.set(key, structuredClone(value)); },
    },
  };
  await setup(ctx, {}, {}, () => {});
  assert.strictEqual(definition.name, 'archive');
  assert.strictEqual(typeof controlMethods.afterArchive, 'function');
  const first = await controlMethods.afterArchive({ sessionID: 'ses_test' });
  const second = definition.execute({ sessionID: 'ses_test', delivery: 'queue' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(hookCalls, 1, 'duplicate archive commands must share one operation');
  assert.strictEqual(first.finalization.state, 'pending');
  assert.strictEqual((await controlMethods.status({ sessionID: 'ses_test' })).finalization.state, 'pending');
  releaseHook();
  await second;
  while ((await controlMethods.status({ sessionID: 'ses_test' })).finalization.state === 'pending') {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepStrictEqual(events.map(([name]) => name), ['hook', 'cleanup', 'wait']);
  assert.deepStrictEqual(events[1][1], {
    sessionID: 'ses_test', name: 'cleanup', text: '', delivery: 'queue',
  });
  await definition.execute({ sessionID: 'ses_test', delivery: 'queue' });
  assert.strictEqual(hookCalls, 1, 'the same archive timestamp must not run the hook again');

  archivedAt = 789;
  ctx.rpc = Object.assign(() => ({ afterArchive: async () => { throw new Error('hook failed'); } }), ctx.rpc);
  await controlMethods.afterArchive({ sessionID: 'ses_test' });
  let failed;
  do {
    await new Promise((resolve) => setImmediate(resolve));
    failed = (await controlMethods.status({ sessionID: 'ses_test' })).finalization;
  } while (failed.state === 'pending');
  assert.strictEqual(failed.state, 'failed', 'hook failure is recorded without restoring the session');
  assert.strictEqual(hookCalls, 1);

  archivedAt = 900;
  cleanupAvailable = false;
  ctx.rpc = Object.assign(() => ({ afterArchive: async (input) => { events.push(['hook-without-cleanup', input]); } }), ctx.rpc);
  await controlMethods.afterArchive({ sessionID: 'ses_test' });
  let withoutCleanup;
  do {
    await new Promise((resolve) => setImmediate(resolve));
    withoutCleanup = (await controlMethods.status({ sessionID: 'ses_test' })).finalization;
  } while (withoutCleanup.state === 'pending');
  assert.strictEqual(withoutCleanup.state, 'succeeded', 'a missing cleanup command preserves the old behavior');
  assert.strictEqual(events.filter(([name]) => name === 'cleanup').length, 1);
  console.log('ARCHIVE SERVICE OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));

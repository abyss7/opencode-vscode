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
  const service = new ArchiveService({
    command: 'opencode',
    log: () => {},
    api: {
      archiveIntegration: async (method, input, directory) => {
        if (method === 'archive') {
          apiCalls.push(['rpc', input, directory]);
          return {};
        }
        statusAttempts += 1;
        if (statusAttempts === 1) throw new Error('reloading');
        return { version: 2 };
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
  await service.archive('ses_service', '/workspace');
  assert.deepStrictEqual(apiCalls, [
    ['rpc', { sessionID: 'ses_service' }, '/workspace'],
    ['update', 'ses_service', { archived: true }],
  ]);
  service.api.archiveIntegration = async (method) => {
    if (method === 'archive') throw new Error('plugin offline');
    return { version: 2 };
  };
  await service.archive('ses_fallback', '/workspace');
  assert.deepStrictEqual(apiCalls.at(-1), ['update', 'ses_fallback', { archived: true }]);

  let definition;
  let controlMethods;
  let archived = false;
  let hookCalls = 0;
  let releaseHook;
  const events = [];
  const ctx = {
    command: { transform: async (edit) => {
      edit({ add: (value) => { definition = value; } });
      return { dispose() {} };
    } },
    rpc: Object.assign(() => ({ beforeArchive: async (input) => {
      hookCalls += 1;
      events.push(['hook', input]);
      await new Promise((resolve) => { releaseHook = resolve; });
    } }), { register: async (_, methods) => { controlMethods = methods; return { dispose() {} }; } }),
    session: {
      get: async () => ({ id: 'ses_test', time: {}, location: { directory: '/workspace' } }),
      list: async () => ({ data: archived ? [{ id: 'ses_test' }] : [], cursor: {} }),
      wait: async () => { events.push(['wait']); },
      update: async (input) => { events.push(['update', input]); archived = input.archived; },
    },
  };
  await setup(ctx, {}, {}, () => {});
  assert.strictEqual(definition.name, 'archive');
  assert.strictEqual(typeof controlMethods.archive, 'function');
  const first = controlMethods.archive({ sessionID: 'ses_test' });
  const second = definition.execute({ sessionID: 'ses_test', delivery: 'queue' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(hookCalls, 1, 'duplicate archive commands must share one operation');
  releaseHook();
  await Promise.all([first, second]);
  assert.deepStrictEqual(events.map(([name]) => name), ['wait', 'hook', 'update']);
  assert.deepStrictEqual(events.at(-1)[1], { sessionID: 'ses_test', archived: true });
  await definition.execute({ sessionID: 'ses_test', delivery: 'queue' });
  assert.strictEqual(hookCalls, 1, 'an archived session must not run the hook again');

  archived = false;
  ctx.rpc = Object.assign(() => ({ beforeArchive: async () => { throw new Error('hook failed'); } }), ctx.rpc);
  await definition.execute({ sessionID: 'ses_test', delivery: 'queue' });
  assert.strictEqual(archived, true, 'hook failures must not prevent archiving');
  console.log('ARCHIVE SERVICE OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));

'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { parseArtifact } = require('../src/artifact-contract');
const base = { schema: 1, id: 'a', version: 1, title: 'A', kind: 'markdown', content: '# Hello' };
assert.deepEqual(parseArtifact(JSON.stringify(base)), base);
for (const changes of [{ schema: 2 }, { version: 0 }, { id: '../a' }, { kind: 'html' }, { kind: 'image', dataUrl: 'javascript:alert(1)' },
  { kind: 'chart', chart: 'line', unit: 'ms', xLabel: 'x', yLabel: 'y', series: [{ name: 'a', values: [{ x: 1, y: null }] }] }]) {
  assert.throws(() => parseArtifact(JSON.stringify({ ...base, ...changes })));
}

const plan = {
  schema: 1, id: 'account-setup', version: 1, title: 'Новый аккаунт', kind: 'plan',
  phases: [
    { id: 'p1', title: 'Подготовка', tasks: [
      { id: 'p1t1', title: 'Создать учётку', status: 'done' },
      { id: 'p1t2', title: 'Настроить 2FA', status: 'doing', note: 'ждать SMS' },
    ] },
    { id: 'p2', title: 'Миграция', tasks: [{ id: 'p2t1', title: 'Перенести ключи', status: 'todo' }] },
  ],
};
assert.deepEqual(parseArtifact(JSON.stringify(plan)), plan);
for (const changes of [
  { phases: [] },
  { phases: [{ id: 'p1', title: 'X', tasks: [] }] },
  { phases: [{ id: 'p1', title: 'X', tasks: [{ id: 't1', title: 'T', status: 'later' }] }] },
  { phases: [{ id: 'p1', title: 'X', tasks: [{ id: 't1', title: 'T', status: 'done', note: 5 }] }] },
  { phases: [{ id: 'p1', title: 'X', tasks: [{ id: 't1', title: 'T', status: 'todo' }, { id: 't1', title: 'U', status: 'todo' }] }] },
  { phases: [{ id: 'p1', title: 'X', tasks: [{ id: 't1', title: 'T', status: 'todo' }] }, { id: 'p1', title: 'Y', tasks: [{ id: 't2', title: 'T', status: 'todo' }] }] },
]) {
  assert.throws(() => parseArtifact(JSON.stringify({ ...plan, ...changes })), JSON.stringify(changes));
}
let destination;
const writes = [];
const load = Module._load;
Module._load = function (name) {
  if (name === 'vscode') return { window: { showSaveDialog: async () => destination }, workspace: { fs: { writeFile: async (...args) => writes.push(args) } } };
  return load.apply(this, arguments);
};
const { exportArtifact } = require('../src/artifact-export');
Module._load = load;
(async () => {
  await exportArtifact({ name: 'a.json', content: JSON.stringify(base) });
  assert.equal(writes.length, 0, 'cancelled export writes nothing');
  destination = { scheme: 'file', path: '/chosen/a.json' };
  await exportArtifact({ name: 'a.json', content: JSON.stringify(base) });
  assert.equal(writes[0][0], destination);
  assert.deepEqual(JSON.parse(writes[0][1].toString()), base);
  console.log('ARTIFACTS OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

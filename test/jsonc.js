'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  JsoncStore,
  applyOperations,
  deepEqual,
  getPath,
  parse,
  setPath,
} = require('../src/jsonc');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonc-'));
const store = new JsoncStore({ log: () => {} });

function file(name) {
  return path.join(base, name);
}

(async () => {
  const withComments = file('opencode.jsonc');
  fs.writeFileSync(
    withComments,
    [
      '{',
      '  // top-level comment',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "model": "openai/gpt-5",',
      '  "permissions": [',
      '    // keep this rule',
      '    { "action": "shell", "resource": "git status *", "effect": "allow" },',
      '  ],',
      '}',
      '',
    ].join('\n')
  );

  const initial = parse(fs.readFileSync(withComments, 'utf8'));
  assert.strictEqual(initial.model, 'openai/gpt-5');
  assert.strictEqual(initial.permissions.length, 1);
  assert.strictEqual(deepEqual(initial.permissions, [{ action: 'shell', resource: 'git status *', effect: 'allow' }]), true);

  await store.write(withComments, [{ path: ['model'], value: 'anthropic/claude-sonnet-5-5' }]);
  const afterSet = fs.readFileSync(withComments, 'utf8');
  assert.ok(afterSet.includes('// top-level comment'), 'top-level comment was lost');
  assert.ok(afterSet.includes('// keep this rule'), 'array comment was lost');
  assert.ok(afterSet.includes('"model": "anthropic/claude-sonnet-5-5"'));
  assert.ok(afterSet.includes('"$schema"'));

  await store.write(withComments, [{ path: ['username'], value: 'alice' }]);
  const afterAdd = fs.readFileSync(withComments, 'utf8');
  assert.ok(afterAdd.includes('"username": "alice"'));
  assert.ok(afterAdd.includes('// top-level comment'));

  await store.write(withComments, [{ path: ['username'], unset: true }]);
  assert.ok(!fs.readFileSync(withComments, 'utf8').includes('"username"'));

  const created = path.join(base, 'new', 'opencode.jsonc');
  await store.write(created, [{ path: ['shell'], value: '/bin/zsh' }]);
  const createdText = fs.readFileSync(created, 'utf8');
  assert.ok(createdText.includes('"$schema": "https://opencode.ai/config.json"'));
  assert.ok(createdText.includes('"shell": "/bin/zsh"'));

  const crlf = file('crlf.json');
  fs.writeFileSync(crlf, '{\r\n  "model": "a/b"\r\n}\r\n');
  await store.write(crlf, [{ path: ['username'], value: 'bob' }]);
  assert.ok(fs.readFileSync(crlf, 'utf8').includes('\r\n'), 'CRLF was not preserved');

  const original = { a: 1, b: { c: [1, 2, 3] } };
  assert.strictEqual(getPath(original, ['b', 'c', 1]), 2);
  assert.strictEqual(getPath(original, ['b', 'missing']), undefined);
  const copy = JSON.parse(JSON.stringify(original));
  setPath(copy, ['b', 'd'], true);
  assert.strictEqual(copy.b.d, true);
  assert.strictEqual(deepEqual(original, copy), false);
  assert.strictEqual(deepEqual(original, JSON.parse(JSON.stringify(original))), true);

  const opsText = applyOperations(
    '{\n  // comment\n  "a": 1,\n}\n',
    [{ path: ['b'], value: false }],
    { format: true }
  );
  assert.ok(opsText.includes('// comment'));
  assert.ok(opsText.includes('"b": false'));

  assert.throws(() => parse('{ bad json'), /Invalid JSONC/);

  fs.rmSync(base, { recursive: true, force: true });
  console.log('JSONC OK');
})().catch((error) => {
  fs.rmSync(base, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});

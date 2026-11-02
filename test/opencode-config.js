'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/opencode-config');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-'));

function touch(file, value = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

(async () => {
  const root = path.join(base, 'project');
  const nested = path.join(root, 'packages', 'web');
  fs.mkdirSync(nested, { recursive: true });

  touch(path.join(root, 'opencode.json'), { username: 'root-json' });
  touch(path.join(root, 'opencode.jsonc'), { username: 'root-jsonc' });
  touch(path.join(root, '.opencode', 'opencode.json'), { username: 'dot-json' });
  touch(path.join(root, '.opencode', 'opencode.jsonc'), { username: 'dot-jsonc' });
  touch(path.join(root, 'packages', 'opencode.json'), { username: 'packages' });
  touch(path.join(nested, 'opencode.jsonc'), { username: 'web' });

  assert.strictEqual(
    config.findConfigFile(root),
    path.join(root, 'opencode.jsonc'),
    'jsonc should win over json in the same directory'
  );

  assert.strictEqual(
    config.projectConfigFile(root),
    path.join(root, '.opencode', 'opencode.jsonc'),
    'the .opencode file should have the highest priority'
  );

  const order = config.discoverProjectConfigFiles(nested);
  assert.deepStrictEqual(order, [
    path.join(root, 'opencode.json'),
    path.join(root, 'opencode.jsonc'),
    path.join(root, 'packages', 'opencode.json'),
    path.join(nested, 'opencode.jsonc'),
    path.join(root, '.opencode', 'opencode.json'),
    path.join(root, '.opencode', 'opencode.jsonc'),
  ]);

  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.strictEqual(
    config.projectConfigFile(empty),
    path.join(empty, 'opencode.jsonc'),
    'the default project file should be opencode.jsonc'
  );

  assert.deepStrictEqual(config.discoverProjectConfigFiles(empty), []);

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(base, 'global');
  const resolved = await config.resolveGlobalConfigDir({
    command: path.join(base, 'missing-opencode'),
  });
  assert.strictEqual(resolved, path.join(base, 'global'));
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previous;

  const candidates = config.machineSettingsCandidates();
  assert.ok(
    candidates.some((candidate) => candidate.includes(path.join('.vscode-server', 'data', 'Machine'))),
    'the VS Code machine settings path is missing'
  );

  fs.rmSync(base, { recursive: true, force: true });
  console.log('CONFIG OK');
})().catch((error) => {
  fs.rmSync(base, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { generate, KEEP_PATHS } = require('../scripts/generate-configuration');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const DEPRECATED = [
  'logLevel',
  'server',
  'command',
  'reference',
  'snapshot',
  'plugin',
  'autoshare',
  'autoupdate',
  'disabled_providers',
  'enabled_providers',
  'small_model',
  'subagent_depth',
  'mode',
  'agent',
  'provider',
  'layout',
  'permission',
  'tools',
  'attachment',
];

function ids(configuration) {
  const opencode = Array.isArray(configuration)
    ? configuration.find((entry) => entry.id === 'opencode')
    : configuration;
  return Object.keys(opencode.properties).filter((id) => id.startsWith('opencode.'));
}

function hasRef(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.$ref === 'string') return true;
  return Object.values(value).some(hasRef);
}

const generated = generate();
const configuration = generated.configuration;
const settingIds = ids(configuration);
const committedMetadata = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'generated', 'opencode-settings.json'), 'utf8')
);

assert.deepStrictEqual(
  committedMetadata.settings,
  generated.settings,
  'src/generated/opencode-settings.json is out of date; run node scripts/generate-configuration.js'
);

assert.deepStrictEqual(
  configuration,
  pkg.contributes.configuration,
  'package.json configuration is out of date; run node scripts/generate-configuration.js'
);

assert.strictEqual(
  generated.settings.length,
  settingIds.length,
  'generated metadata does not match the configuration'
);

for (const meta of generated.settings) {
  assert.strictEqual(
    meta.id,
    `opencode.${meta.path.join('.')}`,
    `metadata path mismatch for ${meta.id}`
  );
  assert.ok(Array.isArray(meta.path) && meta.path.length > 0, `empty path for ${meta.id}`);
  assert.ok(meta.kind, `missing kind for ${meta.id}`);
}

for (const name of DEPRECATED) {
  assert.ok(
    !settingIds.some((id) => id === `opencode.${name}` || id.startsWith(`opencode.${name}.`)),
    `deprecated setting ${name} is still generated`
  );
}

assert.ok(
  !settingIds.includes('opencode.experimental.policies'),
  'deprecated experimental.policies is still generated'
);

for (const key of ['compaction.prune', 'compaction.tail_turns', 'compaction.reserved']) {
  assert.ok(
    !settingIds.includes(`opencode.${key}`),
    `deprecated ${key} is still generated`
  );
}

for (const key of ['skills.paths', 'skills.urls']) {
  assert.ok(
    !settingIds.includes(`opencode.${key}`),
    `deprecated ${key} is still generated`
  );
}

assert.deepStrictEqual(
  settingIds.slice().sort(),
  KEEP_PATHS.map((entry) => `opencode.${entry}`).sort(),
  'the contributed settings must be exactly the settings that affect extension sessions'
);

for (const key of [
  'update',
  'share',
  'enterprise.url',
  'username',
  'timezone',
  'snapshots',
  'warming',
  'worktree.directory',
]) {
  assert.ok(
    !settingIds.some((id) => id === `opencode.${key}` || id.startsWith(`opencode.${key}.`)),
    `setting ${key} does not affect an extension session and must not be contributed`
  );
}

assert.ok(
  !settingIds.some((id) => id.startsWith('opencode.experimental.')),
  'experimental settings must not be contributed'
);

for (const entry of Array.isArray(configuration) ? configuration : [configuration]) {
  assert.ok(!hasRef(entry), `configuration ${entry.id} still contains a $ref`);
  assert.ok(
    !JSON.stringify(entry).includes('"deprecated"'),
    `configuration ${entry.id} still contains deprecated metadata`
  );
}

for (const left of settingIds) {
  for (const right of settingIds) {
    if (left === right) continue;
    assert.ok(
      !right.startsWith(left),
      `setting ${left} is a prefix of ${right}`
    );
  }
}

for (const id of [
  'opencode.model',
  'opencode.default_agent',
  'opencode.permissions',
  'opencode.policies',
  'opencode.agents',
  'opencode.mcp.servers',
  'opencode.providers',
  'opencode.skills',
]) {
  assert.ok(settingIds.includes(id), `missing expected setting ${id}`);
}

const opencode = Array.isArray(configuration)
  ? configuration.find((entry) => entry.id === 'opencode')
  : configuration;
const model = opencode.properties['opencode.model'];
assert.ok(!model.$ref, 'model uses $ref');
assert.strictEqual(model.type, 'string', 'model stays a compact string setting');
assert.strictEqual(model.properties, undefined, 'model has no structured form');
assert.strictEqual(model.enum, undefined, 'model must not carry a runtime enum');
assert.strictEqual(model.enumDescriptions, undefined, 'model must not carry enum descriptions');
assert.ok(
  model.markdownDescription.includes('command:opencode.selectDefaultModel'),
  'model links the live picker command'
);
assert.ok(
  !model.markdownDescription.includes('Reload Window'),
  'model does not ask for a window reload'
);

const agent = opencode.properties['opencode.default_agent'];
assert.strictEqual(agent.type, 'string', 'default_agent stays a compact string setting');
assert.strictEqual(agent.enum, undefined, 'default_agent must not carry a runtime enum');
assert.ok(
  !agent.markdownDescription.includes('Reload Window'),
  'default_agent does not ask for a window reload'
);
assert.strictEqual(opencode.properties['opencode.permissions'].scope, 'resource');

console.log(`SETTINGS OK (${settingIds.length} settings)`);

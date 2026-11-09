'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  agentEnumEntries,
  modelEnumEntries,
  modelRefString,
  refreshSettingEnums,
  updateEnums,
} = require('../src/setting-enums');

const MODELS = [
  {
    providerID: 'acme',
    id: 'chat-large',
    name: 'Chat Large',
    limit: { context: 1000000 },
    cost: [{ input: 0.15, output: 0.6 }],
    variants: [{ id: 'high' }, { id: 'low' }],
  },
  {
    providerID: 'globex',
    id: 'chat-small',
    name: 'Chat Small',
    limit: { context: 128000 },
    cost: [{ input: 0, output: 0 }],
    variants: ['high', 'low'],
  },
  {
    providerID: 'acme',
    id: 'chat-tiny',
    name: 'Chat Tiny',
    variants: [],
  },
  // A record without a provider cannot produce a valid `provider/model` value.
  { id: 'broken' },
  { providerID: 'globex', id: '' },
];

const AGENTS = [
  { id: 'build', name: 'Build', mode: 'primary', hidden: false, description: 'Default agent.' },
  { id: 'plan', name: 'Plan', mode: 'primary', hidden: false, description: 'Read-only agent.' },
  { id: 'summary', name: 'Summary', mode: 'primary', hidden: true },
  { id: 'explore', name: 'Explore', mode: 'subagent', hidden: false },
];

// --- compact form -----------------------------------------------------------

assert.strictEqual(modelRefString('openai/gpt-5'), 'openai/gpt-5');
assert.strictEqual(
  modelRefString({ providerID: 'openai', model: 'gpt-5', variant: 'high' }),
  'openai/gpt-5#high'
);
assert.strictEqual(modelRefString({ providerID: 'openai', model: 'gpt-5' }), 'openai/gpt-5');
assert.strictEqual(modelRefString({ model: 'gpt-5' }), undefined);
assert.strictEqual(modelRefString(undefined), undefined);

// --- model enum -------------------------------------------------------------

const models = modelEnumEntries(MODELS, ['legacy/model']);
assert.deepStrictEqual(models.values, [
  'acme/chat-large',
  'acme/chat-large#high',
  'acme/chat-large#low',
  'acme/chat-tiny',
  'globex/chat-small',
  'globex/chat-small#high',
  'globex/chat-small#low',
  'legacy/model',
]);
assert.strictEqual(models.descriptions.length, models.values.length);
assert.ok(
  models.descriptions.every((text) => typeof text === 'string' && text.length > 0),
  'every enum value has a description'
);
assert.ok(
  models.descriptions[0].includes('1M context'),
  'the model description carries the context size'
);
assert.ok(
  !models.descriptions[0].includes('$'),
  'prices stay out of the enum so the list does not churn'
);
assert.deepStrictEqual(
  models.values,
  [...new Set(models.values)],
  'duplicates are removed'
);
assert.ok(
  models.values.every((value) => !value.includes('undefined')),
  'records without a provider are skipped'
);
assert.deepStrictEqual(modelEnumEntries(MODELS).values.includes('legacy/model'), false);

// --- agent enum -------------------------------------------------------------

const agents = agentEnumEntries(AGENTS, ['custom']);
assert.deepStrictEqual(agents.values, ['build', 'plan', 'custom']);
assert.deepStrictEqual(agents.descriptions.slice(0, 2), ['Default agent.', 'Read-only agent.']);
assert.strictEqual(agentEnumEntries([]).values.length, 0);

// --- writing package.json ---------------------------------------------------

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-enums-'));
const file = path.join(base, 'package.json');
const packageJson = {
  name: 'fixture',
  contributes: {
    configuration: {
      title: 'OpenCode',
      properties: {
        'opencode.model': {
          type: 'string',
          scope: 'resource',
          markdownDescription: '**Default model**',
        },
        'opencode.default_agent': {
          type: 'string',
          scope: 'resource',
        },
        'opencode.shell': { type: 'string' },
      },
    },
  },
};
fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

const first = updateEnums({
  file,
  models: MODELS,
  agents: AGENTS,
  currentModel: { providerID: 'old', model: 'custom', variant: 'max' },
  currentAgent: 'legacy',
});
assert.deepStrictEqual(first, { changed: true, model: true, agent: true });

const written = JSON.parse(fs.readFileSync(file, 'utf8'));
const properties = written.contributes.configuration.properties;
assert.deepStrictEqual(properties['opencode.model'].enum, [
  'acme/chat-large',
  'acme/chat-large#high',
  'acme/chat-large#low',
  'acme/chat-tiny',
  'globex/chat-small',
  'globex/chat-small#high',
  'globex/chat-small#low',
  'old/custom#max',
]);
assert.strictEqual(properties['opencode.model'].enumDescriptions.length, 8);
assert.deepStrictEqual(properties['opencode.default_agent'].enum, [
  'build',
  'plan',
  'legacy',
]);
assert.deepStrictEqual(properties['opencode.shell'], { type: 'string' });
assert.strictEqual(properties['opencode.model'].type, 'string');
assert.strictEqual(properties['opencode.model'].markdownDescription, '**Default model**');
assert.strictEqual(written.name, 'fixture');

// Unchanged lists are left alone: no rewrite, no reported change.
const before = fs.statSync(file).mtimeMs;
const second = updateEnums({
  file,
  models: MODELS,
  agents: AGENTS,
  currentModel: { providerID: 'old', model: 'custom', variant: 'max' },
  currentAgent: 'legacy',
});
assert.deepStrictEqual(second, { changed: false, model: false, agent: false });
assert.strictEqual(fs.statSync(file).mtimeMs, before);

// A configuration array is handled the same way.
const arrayFile = path.join(base, 'array.json');
fs.writeFileSync(
  arrayFile,
  `${JSON.stringify(
    {
      contributes: {
        configuration: [
          { id: 'other', properties: { 'other.setting': { type: 'string' } } },
          {
            id: 'opencode',
            properties: {
              'opencode.model': { type: 'string' },
              'opencode.default_agent': { type: 'string' },
            },
          },
        ],
      },
    },
    null,
    2
  )}\n`,
  'utf8'
);
const arrayResult = updateEnums({ file: arrayFile, models: MODELS, agents: AGENTS });
assert.deepStrictEqual(arrayResult, { changed: true, model: true, agent: true });
const arrayWritten = JSON.parse(fs.readFileSync(arrayFile, 'utf8'));
assert.strictEqual(
  arrayWritten.contributes.configuration[1].properties['opencode.model'].enum.length,
  7
);
assert.strictEqual(
  arrayWritten.contributes.configuration[0].properties['other.setting'].enum,
  undefined
);

// A malformed file is reported, not thrown.
const broken = path.join(base, 'broken.json');
fs.writeFileSync(broken, '{ not json', 'utf8');
assert.deepStrictEqual(updateEnums({ file: broken, models: MODELS, agents: AGENTS }), {
  changed: false,
  model: false,
  agent: false,
});
assert.deepStrictEqual(
  updateEnums({ file: path.join(base, 'missing.json'), models: MODELS, agents: AGENTS }),
  { changed: false, model: false, agent: false }
);

// --- startup refresh --------------------------------------------------------

const startupFile = path.join(base, 'startup.json');
fs.writeFileSync(startupFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
const settings = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8')).contributes.configuration.properties;

const fakeVscode = (values) => ({
  workspace: {
    getConfiguration: () => ({
      get: (key) => values[key],
    }),
  },
});

const fakeApi = (models, agents) => ({
  // The refresh must not need a separate service probe: the catalogue request
  // starts the service itself, so a fresh install fills the lists.
  listModels: async () => models,
  listAgents: async () => agents,
});

(async () => {
  const started = await refreshSettingEnums({
    vscode: fakeVscode({ model: 'old/custom#max' }),
    api: fakeApi(MODELS, AGENTS),
    cwd: '/tmp',
    file: startupFile,
    log: () => {},
  });
  assert.deepStrictEqual(started, { changed: true, model: true, agent: true });
  const written = settings(startupFile);
  assert.ok(written['opencode.model'].enum.includes('old/custom#max'));
  assert.deepStrictEqual(written['opencode.default_agent'].enum, ['build', 'plan']);

  // An unchanged catalogue does not rewrite the file.
  const before = fs.statSync(startupFile).mtimeMs;
  const again = await refreshSettingEnums({
    vscode: fakeVscode({ model: 'old/custom#max' }),
    api: fakeApi(MODELS, AGENTS),
    cwd: '/tmp',
    file: startupFile,
    log: () => {},
  });
  assert.deepStrictEqual(again, { changed: false, model: false, agent: false });
  assert.strictEqual(fs.statSync(startupFile).mtimeMs, before);

  // A failed (empty) catalogue keeps the previous dropdown.
  const empty = await refreshSettingEnums({
    vscode: fakeVscode({}),
    api: fakeApi([], []),
    cwd: '/tmp',
    file: startupFile,
    log: () => {},
  });
  assert.deepStrictEqual(empty, { changed: false, model: false, agent: false });
  assert.ok(settings(startupFile)['opencode.model'].enum.includes('acme/chat-large'));

  console.log('SETTING ENUMS OK');
})().catch((error) => {
  console.error(error);
    process.exit(1);
  });

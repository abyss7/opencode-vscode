'use strict';

const assert = require('node:assert');
const {
  modelChoices,
  effortChoices,
  selectDefaultModel,
} = require('../src/model-defaults');
const { modelRefString, variantIds } = require('../src/model-ref');

const MODELS = [
  {
    providerID: 'acme',
    id: 'chat-large',
    name: 'Chat Large',
    limit: { context: 200000 },
    variants: ['low', 'high'],
  },
  {
    providerID: 'acme',
    id: 'chat-tiny',
    name: 'Chat Tiny',
    limit: { context: 32000 },
  },
  {
    providerID: 'globex',
    id: 'small',
    name: 'Small',
    limit: { context: 1000000 },
    variants: [{ id: 'max' }],
  },
  { providerID: 'broken' },
];

// --- model references -------------------------------------------------------

assert.strictEqual(
  modelRefString({ providerID: 'acme', model: 'chat-large', variant: 'high' }),
  'acme/chat-large#high'
);
assert.strictEqual(modelRefString('acme/chat-large#high'), 'acme/chat-large#high');
assert.strictEqual(modelRefString({ providerID: 'acme' }), undefined);
assert.strictEqual(modelRefString(null), undefined);
assert.deepStrictEqual(variantIds(MODELS[0]), ['low', 'high']);
assert.deepStrictEqual(variantIds(MODELS[2]), ['max']);
assert.deepStrictEqual(variantIds({}), []);

// --- quick pick items -------------------------------------------------------

const SEPARATOR = -1;
const choices = modelChoices(MODELS, SEPARATOR);
assert.deepStrictEqual(
  choices.filter((choice) => choice.kind === SEPARATOR).map((choice) => choice.label),
  ['acme', 'globex'],
  'models are grouped by provider'
);
assert.strictEqual(
  choices.filter((choice) => choice.model).length,
  3,
  'models without an id are skipped'
);
const large = choices.find((choice) => choice.description === 'acme/chat-large');
assert.strictEqual(large.label, 'Chat Large');
assert.strictEqual(large.detail, 'Chat Large · 200k context · effort: low, high');
assert.ok(
  modelChoices(MODELS).every((choice) => choice.kind === undefined),
  'separators are omitted when the API does not expose the kind'
);

assert.deepStrictEqual(
  effortChoices(MODELS[0]).map((choice) => [choice.label, choice.variant]),
  [
    ['Default', ''],
    ['Low', 'low'],
    ['High', 'high'],
  ]
);
assert.deepStrictEqual(
  effortChoices(MODELS[2]).map((choice) => choice.variant),
  ['', 'max']
);

// --- command flow -----------------------------------------------------------

function harness(answers, options = {}) {
  const calls = [];
  const shown = [];
  const vscode = {
    QuickPickItemKind: { Separator: SEPARATOR },
    ConfigurationTarget: { Global: 1, WorkspaceFolder: 2 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    workspace: {
      getWorkspaceFolder: () => (options.folder ? { uri: {} } : undefined),
      getConfiguration: () => ({
        update: async (key, value, target) => calls.push({ key, value, target }),
      }),
    },
    window: {
      showQuickPick: async (items, pickOptions) => {
        shown.push(pickOptions.title);
        return answers.shift();
      },
      showWarningMessage: (message) => calls.push({ warning: message }),
    },
  };
  return { vscode, calls, shown };
}

const listModels = (models) => async () => models;

(async () => {
  // Model and effort: the compact reference is written to the setting.
  const first = harness([
    modelChoices(MODELS).find((choice) => choice.description === 'acme/chat-large'),
    effortChoices(MODELS[0]).find((choice) => choice.variant === 'high'),
  ], { folder: true });
  const value = await selectDefaultModel({
    vscode: first.vscode,
    api: { listModels: listModels(MODELS) },
    cwd: '/work',
  });
  assert.strictEqual(value, 'acme/chat-large#high');
  assert.deepStrictEqual(first.calls, [
    { key: 'model', value: 'acme/chat-large#high', target: 2 },
  ]);
  assert.deepStrictEqual(first.shown, [
    'Default model for new sessions',
    'Effort for Chat Large',
  ]);

  // A model without variants needs one step only and falls back to Global.
  const second = harness([
    modelChoices(MODELS).find((choice) => choice.description === 'acme/chat-tiny'),
  ]);
  const plain = await selectDefaultModel({
    vscode: second.vscode,
    api: { listModels: listModels(MODELS) },
  });
  assert.strictEqual(plain, 'acme/chat-tiny');
  assert.deepStrictEqual(second.calls, [
    { key: 'model', value: 'acme/chat-tiny', target: 1 },
  ]);
  assert.deepStrictEqual(second.shown, ['Default model for new sessions']);

  // Cancelling either step writes nothing.
  const cancelled = harness([undefined]);
  assert.strictEqual(
    await selectDefaultModel({
      vscode: cancelled.vscode,
      api: { listModels: listModels(MODELS) },
      cwd: '/work',
    }),
    null
  );
  assert.deepStrictEqual(cancelled.calls, []);

  const cancelledEffort = harness([
    modelChoices(MODELS).find((choice) => choice.description === 'acme/chat-large'),
    undefined,
  ]);
  assert.strictEqual(
    await selectDefaultModel({
      vscode: cancelledEffort.vscode,
      api: { listModels: listModels(MODELS) },
      cwd: '/work',
    }),
    null
  );
  assert.deepStrictEqual(cancelledEffort.calls, []);

  // An empty catalogue warns instead of showing an empty picker.
  const empty = harness([]);
  assert.strictEqual(
    await selectDefaultModel({
      vscode: empty.vscode,
      api: { listModels: listModels([]) },
      cwd: '/work',
    }),
    null
  );
  assert.deepStrictEqual(empty.shown, []);
  assert.strictEqual(empty.calls.length, 1);
  assert.ok(empty.calls[0].warning.includes('No OpenCode models'));

  console.log('MODEL DEFAULTS OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

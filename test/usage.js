'use strict';

const assert = require('node:assert');
const {
  usageTotal,
  compactionThreshold,
  parseModelRef,
  matchModel,
  resolveBudget,
  modelPrices,
  splitStepCost,
  summarizeCost,
} = require('../src/usage');

assert.strictEqual(
  usageTotal({ input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 3 } }),
  120
);
assert.strictEqual(usageTotal(null), 0);
assert.strictEqual(usageTotal({}), 0);

// The model declares a 200k context window and a 160k input window; the
// server compacts against the input window.
assert.strictEqual(
  compactionThreshold({
    context: 200000,
    input: 160000,
    compaction: { buffer: 20000 },
  }),
  140000,
  'input window wins over the context window'
);
assert.strictEqual(compactionThreshold({ context: 200000, compaction: {} }), 170000);
assert.strictEqual(
  compactionThreshold({ context: 100000, compaction: { buffer: 100000 } }),
  84000,
  'a buffer as large as the window falls back to the default'
);
assert.strictEqual(compactionThreshold({ context: 10000, compaction: {} }), 8500);
assert.strictEqual(
  compactionThreshold({ context: 1048576, compaction: { buffer: 800000 } }),
  248576
);
assert.strictEqual(
  compactionThreshold({ context: 200000, compaction: { auto: false } }),
  0
);
assert.strictEqual(compactionThreshold({}), 0);

assert.deepStrictEqual(parseModelRef('acme/chat-large'), {
  providerID: 'acme',
  id: 'chat-large',
});
assert.deepStrictEqual(parseModelRef('openrouter/anthropic/claude-3.5-sonnet'), {
  providerID: 'openrouter',
  id: 'anthropic/claude-3.5-sonnet',
});
assert.deepStrictEqual(parseModelRef('acme/chat-large#high'), {
  providerID: 'acme',
  id: 'chat-large',
  variant: 'high',
});
assert.strictEqual(parseModelRef(''), null);
assert.strictEqual(parseModelRef('plain'), null);
assert.strictEqual(parseModelRef('/model'), null);

const models = [
  { providerID: 'acme', id: 'chat-large', limit: { context: 1048576 } },
  { providerID: 'other', id: 'chat-large', limit: { context: 1 } },
];
assert.strictEqual(
  matchModel(models, { providerID: 'acme', id: 'chat-large' }).limit.context,
  1048576
);
assert.strictEqual(matchModel(models, { id: 'missing' }), null);

const eachBudget = {
  id: 'per-model',
  limit: 10,
  spent: 3,
  scope: 'each',
  per: 'model',
  coverage: 'models',
  picked: true,
  models: [
    {
      providerID: 'acme',
      modelID: 'chat-large',
      name: 'Chat Large',
      spent: 1.5,
    },
  ],
  resetsAt: 123,
};
const budget = resolveBudget(
  { budgets: [eachBudget] },
  { providerID: 'acme', id: 'chat-large', inputPrice: 0.15 }
);
assert.strictEqual(budget.remaining, 8.5);
assert.strictEqual(budget.modelMatched, true);
assert.strictEqual(budget.label, 'Chat Large');
assert.strictEqual(budget.resetsAt, 123);

const combined = resolveBudget(
  { budgets: [{ ...eachBudget, scope: 'combined' }] },
  { providerID: 'acme', id: 'chat-large', inputPrice: 0.15 }
);
assert.strictEqual(combined.remaining, 7);

const allModels = resolveBudget(
  { budgets: [{ ...eachBudget, coverage: 'all', scope: 'combined' }] },
  { providerID: 'globex', id: 'chat-small' }
);
assert.strictEqual(allModels.remaining, 7);

assert.strictEqual(
  resolveBudget(
    { budgets: [{ ...eachBudget, inputPriceAtLeast: 1 }] },
    { providerID: 'acme', id: 'chat-large', inputPrice: 0.15 }
  ),
  null,
  'a model below the input price floor is not covered'
);
assert.strictEqual(
  resolveBudget({ budgets: [eachBudget] }, { providerID: 'acme', id: 'other' }),
  null
);
assert.strictEqual(resolveBudget(null, { providerID: 'acme', id: 'x' }), null);

// Prices come from the catalog record; reasoning is billed as output.
const flash = modelPrices({
  cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
});
assert.deepStrictEqual(flash, {
  input: 0.15,
  output: 0.6,
  cacheRead: 0.003,
  cacheWrite: 0,
});
assert.strictEqual(modelPrices({ cost: [] }), null);
assert.strictEqual(modelPrices(null), null);

// A step's stored cost is authoritative, so peak-hour rates survive: the
// shares keep the proportions implied by the price table but add up to the
// billed amount.
const step = splitStepCost(
  { input: 1000, output: 100, reasoning: 50, cache: { read: 500000, write: 0 } },
  flash,
  0.004
);
assert.strictEqual(step.billed, 0.004);
// 150 input weight vs 1500 cache-read weight out of 0.004 billed.
assert.ok(Math.abs(step.shares.input - (0.004 * 150) / 1740) < 1e-12);
assert.ok(Math.abs(step.shares.cacheRead - (0.004 * 1500) / 1740) < 1e-12);
const shareSum =
  step.shares.input + step.shares.output + step.shares.cacheRead + step.shares.cacheWrite;
assert.ok(Math.abs(shareSum - 0.004) < 1e-12, 'shares add up to the billed cost');

// Without a stored cost the catalog prices are used directly.
const priced = splitStepCost(
  { input: 1000000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  flash
);
assert.ok(Math.abs(priced.billed - 0.15) < 1e-12);

assert.strictEqual(splitStepCost({ input: 0 }, flash, 0), null);
assert.strictEqual(splitStepCost({ input: 5 }, null, 1), null);

// Session totals: collected steps are scaled up to the stored session cost,
// because the API drops pre-compaction history the cost still covers.
const summary = summarizeCost(
  [
    { tokens: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 }, shares: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0 }, billed: 0.003 },
    { tokens: { input: 200, output: 20, cacheRead: 1800, cacheWrite: 0 }, shares: { input: 0.002, output: 0.002, cacheRead: 0.002, cacheWrite: 0 }, billed: 0.006 },
  ],
  0.012
);
assert.ok(Math.abs(summary.scale - 0.012 / 0.009) < 1e-12);
assert.strictEqual(summary.rows.find((row) => row.key === 'input').tokens, 300);
assert.ok(
  Math.abs(summary.rows.reduce((sum, row) => sum + row.cost, 0) - 0.012) < 1e-12,
  'the rows add up to the stored session cost'
);
assert.strictEqual(summarizeCost([], 0).total, 0);
assert.strictEqual(summarizeCost(null, 5).total, 5);

async function checkSubscription() {
  const { OpenCodeApi } = require('../src/api');
  const api = Object.create(OpenCodeApi.prototype);
  let connections;
  api._request = async (method, url) => {
    assert.strictEqual(method, 'GET');
    assert.strictEqual(url, '/api/integration/openai?location%5Bdirectory%5D=%2Fworkspace');
    return { data: { connections } };
  };
  for (const [value, expected] of [
    [[{ type: 'credential', method: 'oauth' }], true],
    [[{ type: 'credential', method: 'key' }], false],
    [[{ type: 'env', name: 'OPENAI_API_KEY' }], false],
    [[{ type: 'credential', method: 'oauth', status: { status: 'needs_auth' } }], false],
    [[{ type: 'credential', method: 'oauth' }, { type: 'env' }], false],
    [[], false],
    [undefined, false],
  ]) {
    connections = value;
    assert.strictEqual(await api.getChatGPTSubscription('/workspace'), expected);
  }

  const Module = require('node:module');
  const originalLoad = Module._load;
  let SessionPanel;
  try {
    Module._load = function (request) {
      return request === 'vscode' ? {} : originalLoad.apply(this, arguments);
    };
    ({ SessionPanel } = require('../src/session-panel'));
  } finally {
    Module._load = originalLoad;
  }
  const panel = Object.create(SessionPanel.prototype);
  const messages = [];
  const errors = [];
  panel._modelRef = { providerID: 'openai', id: 'chat' };
  panel._post = (message) => messages.push(message);
  panel.deps = {
    log: (text) => errors.push(text),
    api: {
      listModels: async () => [{ providerID: 'openai', id: 'chat', limit: { context: 200000, input: 160000 } }],
      getChatGPTSubscription: async () => true,
    },
  };
  await panel._refreshModelContext();
  assert.strictEqual(messages.at(-1).subscription, true);
  assert.strictEqual(messages.at(-1).input, 160000);
  panel.deps.api.getChatGPTSubscription = async () => { throw new Error('offline'); };
  await panel._refreshModelContext();
  assert.strictEqual(messages.at(-1).subscription, false);
  assert.strictEqual(messages.at(-1).context, 200000, 'billing failure preserves model limits');
  assert.strictEqual(errors.length, 1);

  let resolve;
  panel.deps.api.getChatGPTSubscription = () => new Promise((done) => { resolve = done; });
  const pending = panel._refreshModelContext();
  panel._modelRef = { providerID: 'deepseek', id: 'chat' };
  await panel._refreshModelContext();
  const count = messages.length;
  resolve(true);
  await pending;
  assert.strictEqual(messages.length, count, 'old OpenAI response cannot overwrite the selected provider');
  assert.strictEqual(messages.at(-1).subscription, false);
}

checkSubscription().then(() => console.log('USAGE OK')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

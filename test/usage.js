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
assert.strictEqual(
  compactionThreshold({ context: 100000, compaction: { buffer: null } }),
  84000,
  'a null buffer falls back to the default instead of coercing to zero'
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
  assert.strictEqual(messages.at(-1).billing.kind, 'subscription');
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
  assert.strictEqual(messages.at(-1).billing.kind, 'metered');

  panel._costSteps = new Map([
    ['paid', { model: 'deepseek/chat', billed: 0.5, tokens: { input: 100 }, shares: { input: 0.5 } }],
    ['other', { model: 'other/chat', billed: 2, tokens: { input: 100 }, shares: { input: 2 } }],
  ]);
  panel._sessionCost = 99;
  panel._postCostSplit();
  assert.strictEqual(messages.at(-1).total, 0.5, 'selected model never scales to the session total');
  assert.deepStrictEqual(messages.at(-1).model, { providerID: 'deepseek', id: 'chat' });
  panel._modelRef = { providerID: 'new', id: 'chat' };
  panel._postCostSplit();
  assert.strictEqual(messages.at(-1).total, 0, 'a new model has no inherited spending');
  assert.deepStrictEqual(messages.at(-1).rows, []);
}

async function checkUsageRestoration() {
  const { SessionPanel } = require('../src/session-panel');
  const panel = Object.create(SessionPanel.prototype);
  const messages = [];
  const model = { providerID: 'openai', id: 'chat', variant: 'high' };
  const configOptions = [
    { category: 'model', currentValue: 'openai/chat' },
    { id: 'effort', currentValue: 'high' },
  ];
  Object.assign(panel, {
    sessionId: 'session', cwd: '/workspace',
    _post: (message) => messages.push(message),
    _resendSubagents: () => {}, _refreshBalance: () => {}, _postCostSplit: () => {},
    _start: () => panel._syncModelOptions(configOptions),
    deps: {
      log: (error) => { throw new Error(error); },
      api: {
        listModels: async () => [{ ...model, limit: { context: 400000, input: 272000 } }],
        getChatGPTSubscription: async () => true,
        getUsageLimits: async () => null,
        getConfig: async () => [{ info: { compaction: { buffer: 40800 } } }],
        getSession: async () => ({ model, cost: 0 }),
        listMessages: async () => [{ type: 'assistant', id: 'message' }],
        getMessage: async () => ({ model, tokens: { input: 1200 } }),
      },
    },
  });
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  // Constructor metadata can finish before the webview installs its listener.
  panel._setModelRef(model);
  await settled();
  messages.length = 0;
  panel._onMessage({ type: 'ready' });
  await settled();
  const limit = messages.find((message) => message.type === 'modelLimit');
  assert.equal(limit?.input, 272000, 'initial ready resends input limits even when the model is unchanged');
  assert.equal(limit.subscription, true, 'initial ready restores ChatGPT billing before the turn ends');

  // A new webview can attach to the existing client while its turn is running.
  panel._started = true;
  panel._busy = true;
  panel._client = { shared: true, configOptions, replay: async () => {} };
  messages.length = 0;
  panel._onMessage({ type: 'ready' });
  await settled();
  assert.equal(messages.find((message) => message.type === 'modelLimit')?.input, 272000);
  assert.equal(messages.find((message) => message.type === 'modelLimit')?.subscription, true);
  assert.deepEqual(messages.find((message) => message.type === 'compaction')?.compaction, { buffer: 40800 });
  assert.equal(messages.find((message) => message.update?.sessionUpdate === 'usage_update')?.update.used, 1200);
  assert.equal(panel._busy, true, 'usage restoration does not wait for or finish the running turn');
}

checkSubscription().then(checkUsageRestoration).then(() => console.log('USAGE OK')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert');
const {
  getBalance,
  parseCredentialExport,
  parseDeepSeekBalance,
  parseZaiPlanUsage,
  parseChatGPTUsage,
  resetBalanceCache,
} = require('../src/balance');

(async () => {
  const credentials = parseCredentialExport(
    'log line before\n[{"integrationID":"deepseek","active":true,"value":{"type":"key","key":"secret"}}]'
  );
  assert.strictEqual(credentials[0].value.key, 'secret');
  assert.deepStrictEqual(parseCredentialExport('{"credentials":[{"id":"x"}]}'), [
    { id: 'x' },
  ]);
  assert.deepStrictEqual(parseCredentialExport('not json'), []);

  const usd = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      {
        currency: 'USD',
        total_balance: '13.65',
        granted_balance: '0.00',
        topped_up_balance: '13.65',
      },
    ],
  });
  assert.strictEqual(usd.amount, 13.65);
  assert.strictEqual(usd.currency, 'USD');
  assert.strictEqual(usd.available, true);

  const cny = parseDeepSeekBalance({
    balance_infos: [{ currency: 'CNY', total_balance: '98.5' }],
  });
  assert.strictEqual(cny.currency, 'CNY');
  assert.strictEqual(cny.amount, 98.5);

  assert.strictEqual(parseDeepSeekBalance({ balance_infos: [] }), null);
  assert.strictEqual(parseDeepSeekBalance(null), null);

  const plan = parseZaiPlanUsage({
    code: 200,
    data: {
      level: 'pro',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 7995, remaining: 52004, percentage: 13, nextResetTime: 1794748133998 },
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 2732, remaining: 9267, percentage: 22, nextResetTime: 1794614503943 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 1828, percentage: 45 },
      ],
    },
  });
  assert.strictEqual(plan.provider, 'zai-coding-plan');
  assert.strictEqual(plan.plan, 'pro');
  assert.deepStrictEqual(plan.windows, [
    { kind: 'fiveHour', unit: 'credits', used: 2732, limit: 12000, remaining: 9267, percentage: 22, resetsAt: 1794614503943 },
    { kind: 'weekly', unit: 'credits', used: 7995, limit: 60000, remaining: 52004, percentage: 13, resetsAt: 1794748133998 },
  ]);

  // Token plans and the legacy unit-less five-hour row both read as windows.
  const tokens = parseZaiPlanUsage({
    data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 44 }] },
  });
  assert.deepStrictEqual(tokens.windows, [
    { kind: 'fiveHour', unit: 'tokens', used: 0, limit: 0, remaining: 0, percentage: 44, resetsAt: 0 },
  ]);

  // Duplicated and unknown window shapes are skipped, short responses keep
  // their percentages without absolute counts.
  assert.deepStrictEqual(
    parseZaiPlanUsage({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 7 },
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 9 },
          { type: 'TOKENS_LIMIT', unit: 9, percentage: 50 },
          { type: 'TIME_LIMIT', unit: 3, percentage: 5 },
        ],
      },
    }).windows,
    [{ kind: 'fiveHour', unit: 'tokens', used: 0, limit: 0, remaining: 0, percentage: 7, resetsAt: 0 }]
  );

  assert.strictEqual(parseZaiPlanUsage({ data: { limits: [] } }), null);
  assert.strictEqual(parseZaiPlanUsage({ data: { limits: [{ type: 'TIME_LIMIT', percentage: 9 }] } }), null);
  assert.strictEqual(parseZaiPlanUsage(null), null);

  resetBalanceCache();
  let planRequests = 0;
  const planBalance = await getBalance('zai-coding-plan', {
    force: true,
    env: {},
    exec: async (command, args) => {
      assert.deepStrictEqual(args, ['auth', 'export', 'zai-coding-plan']);
      return { stdout: '[{"active":true,"value":{"type":"key","key":"plan"}}]' };
    },
    request: async (url, headers) => {
      planRequests += 1;
      assert.strictEqual(url, 'https://api.z.ai/api/monitor/usage/quota/limit');
      assert.strictEqual(headers.authorization, 'Bearer plan');
      return {
        data: {
          level: 'max',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, percentage: 21, nextResetTime: 1 },
            { type: 'TOKENS_LIMIT', unit: 6, percentage: 4 },
          ],
        },
      };
    },
  });
  assert.strictEqual(planRequests, 1);
  assert.strictEqual(planBalance.plan, 'max');
  assert.strictEqual(planBalance.windows.length, 2);

  resetBalanceCache();
  assert.strictEqual(await getBalance('unknown'), null);

  const weekly = { used_percent: 6, limit_window_seconds: 604800, reset_at: 1795529041 };
  const short = { used_percent: 22, limit_window_seconds: 18000, reset_at: 1795000000 };
  const usage = { plan_type: 'prolite', rate_limit: { primary_window: weekly, secondary_window: null } };
  const chatgpt = parseChatGPTUsage(usage);
  assert.strictEqual(chatgpt.plan, 'prolite');
  assert.strictEqual(chatgpt.windows.length, 1, 'do not invent a five-hour window');
  assert.deepStrictEqual(chatgpt.windows[0], {
    kind: 'weekly', label: 'weekly', durationSeconds: 604800, percentage: 6, resetsAt: 1795529041000,
  });
  assert.deepStrictEqual(parseChatGPTUsage({
    rate_limit: { primary_window: weekly, secondary_window: short },
  }).windows.map((item) => item.kind), ['fiveHour', 'weekly']);
  assert.strictEqual(parseChatGPTUsage(null), null);
  assert.strictEqual(parseChatGPTUsage({ rate_limit: { primary_window: {} } }), null);
  assert.strictEqual(parseChatGPTUsage({ rate_limit: { primary_window: {
    used_percent: null, limit_window_seconds: 18000,
  } } }), null);
  assert.strictEqual(parseChatGPTUsage({ rate_limit: { primary_window: {
    ...short, used_percent: 140,
  } } }).windows[0].percentage, 100);

  let auth = {
    type: 'oauth', methodID: 'chatgpt-browser', access: 'test-token',
    metadata: { accountID: 'account-a' },
  };
  let quotaCalls = 0;
  let quotaError = null;
  const quotaOptions = {
    command: 'custom-opencode', cwd: '/workspace', env: { OPENAI_API_KEY: 'not-codex' },
    exec: async (command, args, opts) => {
      assert.strictEqual(command, 'custom-opencode');
      assert.deepStrictEqual(args, ['auth', 'export', 'openai']);
      assert.strictEqual(opts.cwd, '/workspace');
      return { stdout: JSON.stringify([
        { active: false, value: { ...auth, access: 'inactive' } },
        { active: true, value: auth },
      ]) };
    },
    request: async (url, headers) => {
      quotaCalls += 1;
      assert.strictEqual(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.strictEqual(headers.authorization, `Bearer ${auth.access}`);
      assert.strictEqual(headers['ChatGPT-Account-Id'], auth.metadata.accountID);
      if (quotaError) throw quotaError;
      return usage;
    },
  };
  resetBalanceCache();
  const [quotaA, quotaB] = await Promise.all([
    getBalance('openai', quotaOptions), getBalance('openai', quotaOptions),
  ]);
  assert.strictEqual(quotaA, quotaB);
  assert.strictEqual(quotaCalls, 1, 'concurrent panels share quota request');
  await getBalance('openai', quotaOptions);
  assert.strictEqual(quotaCalls, 1, 'quota is cached for one minute');
  auth = { ...auth, metadata: { accountID: 'account-b' } };
  await getBalance('openai', quotaOptions);
  assert.strictEqual(quotaCalls, 2, 'account switch cannot reuse cached quota');
  quotaError = new Error('offline');
  assert.strictEqual((await getBalance('openai', { ...quotaOptions, force: true })).provider, 'openai');
  quotaError.statusCode = 401;
  await assert.rejects(getBalance('openai', { ...quotaOptions, force: true }), /offline/);
  await assert.rejects(getBalance('openai', quotaOptions), /offline/, 'rejected auth clears cached quota');
  quotaError = null;
  const callsBeforeUnsupported = quotaCalls;
  for (const value of [
    { type: 'key', key: 'api-key' },
    { ...auth, methodID: 'chatgpt-token-sharing' },
    { ...auth, access: '' },
    { ...auth, metadata: {} },
  ]) {
    const saved = auth;
    auth = value;
    assert.strictEqual(await getBalance('openai', quotaOptions), null);
    auth = saved;
  }
  assert.strictEqual(await getBalance('openai', {
    ...quotaOptions, exec: async () => ({ stdout: JSON.stringify([{ active: false, value: auth }]) }),
  }), null);
  assert.strictEqual(quotaCalls, callsBeforeUnsupported, 'unsupported auth never queries ChatGPT');

  let execCalls = 0;
  let requestCalls = 0;
  const options = {
    command: 'opencode',
    force: true,
    env: {},
    exec: async (command, args) => {
      execCalls += 1;
      assert.strictEqual(command, 'opencode');
      assert.deepStrictEqual(args, ['auth', 'export', 'deepseek']);
      return { stdout: '[{"active":true,"value":{"type":"key","key":"k"}}]' };
    },
    request: async (url, headers) => {
      requestCalls += 1;
      assert.ok(url.startsWith('https://api.deepseek.com/'));
      assert.strictEqual(headers.authorization, 'Bearer k');
      return {
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '5.00' }],
      };
    },
  };
  const first = await getBalance('deepseek', options);
  assert.strictEqual(first.amount, 5);
  assert.strictEqual(execCalls, 1);
  assert.strictEqual(requestCalls, 1);

  const cached = await getBalance('deepseek', { ...options, force: false });
  assert.strictEqual(cached.amount, 5);
  assert.strictEqual(requestCalls, 1, 'the cached value is reused');

  const forced = await getBalance('deepseek', { ...options, force: true });
  assert.strictEqual(forced.amount, 5);
  assert.strictEqual(requestCalls, 2);

  resetBalanceCache();
  const fromEnv = await getBalance('deepseek', {
    force: true,
    env: { DEEPSEEK_API_KEY: 'env-key' },
    exec: async () => {
      throw new Error('exec must not run when the environment has a key');
    },
    request: async (url, headers) => {
      assert.strictEqual(headers.authorization, 'Bearer env-key');
      return { balance_infos: [{ currency: 'USD', total_balance: '1.00' }] };
    },
  });
  assert.strictEqual(fromEnv.amount, 1);

  resetBalanceCache();
  await assert.rejects(
    getBalance('deepseek', {
      force: true,
      env: {},
      exec: async () => ({ stdout: '[]' }),
      request: async () => ({ balance_infos: [] }),
    }),
    /no credential found/
  );

  resetBalanceCache();
  await assert.rejects(
    getBalance('deepseek', {
      force: true,
      env: {},
      exec: async () => ({ stdout: '[{"active":true,"value":{"key":"k"}}]' }),
      request: async () => ({ balance_infos: [] }),
    }),
    /no usable amount/
  );

  console.log('BALANCE OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

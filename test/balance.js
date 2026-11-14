'use strict';

const assert = require('node:assert');
const {
  getBalance,
  parseCredentialExport,
  parseDeepSeekBalance,
  parseZaiPlanUsage,
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

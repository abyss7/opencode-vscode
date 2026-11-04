'use strict';

const { test, expect } = require('./fixture');

test('context shows the input limit once and preserves the cache indicator', async ({ page, chat }) => {
  await chat.send(
    { type: 'modelLimit', context: 1200000, input: 1000000 },
    { type: 'compaction', compaction: { auto: true, buffer: 20000 } },
    { type: 'cacheStats', prompt: 1200, read: 1152, at: Date.parse('2026-01-01T10:00:00Z') }
  );
  await expect(page.locator('#usage')).toHaveText('context: 1.2k / 1M (96% cached 2 h ago) · compaction at 980k');
  await chat.send({ type: 'compaction', compaction: { auto: false } });
  await expect(page.locator('#usage')).toHaveText('context: 1.2k / 1M (96% cached 2 h ago)');
});

test('billed tokens are not presented as context and unknown limits stay unknown', async ({ page, chat }) => {
  await chat.send({ type: 'turnEnd', usage: { totalTokens: 99000 } });
  await expect(page.locator('#usage')).toHaveText('context: —');
  await chat.send({ type: 'modelLimit', context: 1000000 });
  await expect(page.locator('#usage')).toHaveText('context: — / 1M · compaction at 850k');
  await chat.update({ sessionUpdate: 'usage_update', used: 0 });
  await expect(page.locator('#usage')).toHaveText('context: 0 / 1M · compaction at 850k');
});

test('ChatGPT subscription opens usage settings and hides misleading zero cost and resets', async ({ page, chat }) => {
  await chat.send(
    { type: 'modelLimit', context: 200000, input: 160000, subscription: true },
    { type: 'turnEnd', usage: { used: 1200, cost: { amount: 0, currency: 'USD' } } },
    { type: 'limits', limits: { go: { weekly: { resetsAt: 1893456000000 } } }, budget: { remaining: 10 } },
    { type: 'balance', balance: { amount: 12, currency: 'USD' } }
  );
  await expect(page.locator('#usage-subscription')).toBeVisible();
  await expect(page.locator('#usage-cost')).toBeHidden();
  await expect(page.locator('#usage-reset')).toBeHidden();
  const link = page.getByRole('link', { name: 'usage ↗' });
  await link.focus();
  await page.keyboard.press('Enter');
  expect(await chat.received('openExternal')).toEqual([{ type: 'openExternal', url: 'https://chatgpt.com/settings/usage' }]);

  // Paid earlier models and subagents remain visible in a mixed session.
  await chat.send({ type: 'subagents', items: [], totalCost: 0.25 });
  await expect(page.locator('#usage-cost')).toHaveText('cost: $0.2500 (sub-agents $0.2500)');
});

test('switching to API billing restores cost and DeepSeek balance', async ({ page, chat }) => {
  await chat.send({ type: 'modelLimit', context: 200000, subscription: true });
  await expect(page.locator('#usage-subscription')).toBeVisible();
  await chat.send(
    { type: 'modelLimit', context: 128000, subscription: false },
    { type: 'turnEnd', usage: { used: 1200, cost: { amount: 0.18, currency: 'USD' } } },
    { type: 'balance', balance: { amount: 12.40, currency: 'USD' } }
  );
  await expect(page.locator('#usage-subscription')).toBeHidden();
  await expect(page.locator('#usage-cost')).toHaveText('cost: $0.1800 · balance: $12.40');
});

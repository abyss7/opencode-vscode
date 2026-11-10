'use strict';

const { test, expect } = require('./fixture');

const agent = { type: 'config', configOptions: [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
] };

async function metadata(chat, subscription = true) {
  await chat.send(agent,
    { type: 'modelLimit', context: 500000, input: 500000, subscription },
    { type: 'compaction', compaction: { auto: true, buffer: 75000 } },
    { type: 'cacheStats', prompt: 135500, read: 135290, at: Date.parse('2026-01-01T12:00:00Z') }
  );
}

test('agent, centered context and right-aligned billing share the input metadata row', async ({ page, chat }) => {
  await metadata(chat);
  const row = await page.locator('.usage-bar').boundingBox();
  const left = await page.locator('#agent-label').boundingBox();
  const center = await page.locator('#usage').boundingBox();
  const right = await page.locator('.usage-details').boundingBox();
  const prompt = await page.locator('.prompt-box').boundingBox();
  expect(left.x).toBeCloseTo(row.x, 0);
  expect(center.x + center.width / 2).toBeCloseTo(row.x + row.width / 2, 0);
  expect(right.x + right.width).toBeCloseTo(row.x + row.width, 0);
  expect(row.x).toBeCloseTo(prompt.x, 0);
  expect(row.width).toBeCloseTo(prompt.width, 0);
  expect(row.y + row.height).toBeLessThanOrEqual(prompt.y);
  if (page.viewportSize().width > 700) {
    expect(left.y + left.height / 2).toBeCloseTo(center.y + center.height / 2, 0);
    expect(right.y + right.height / 2).toBeCloseTo(center.y + center.height / 2, 0);
    expect(left.x + left.width).toBeLessThanOrEqual(center.x);
    expect(center.x + center.width).toBeLessThanOrEqual(right.x);
  } else {
    expect(left.y + left.height).toBeLessThanOrEqual(center.y);
    expect(right.y + right.height).toBeLessThanOrEqual(center.y);
  }
  await expect(page.locator('#usage')).toHaveAttribute('aria-label', /Compaction threshold: 425,000 tokens/);
  await expect(page.locator('#usage-subscription')).toBeVisible();
  await chat.snapshot('composer-meta');
});

test('pasted image attachments appear above the entire metadata row', async ({ page, chat }) => {
  await metadata(chat);
  await page.locator('#input').evaluate((input) => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], 'context.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#attachments img')).toBeVisible();
  const images = await page.locator('#attachments').boundingBox();
  const row = await page.locator('.usage-bar').boundingBox();
  const left = await page.locator('#agent-label').boundingBox();
  expect(images.y + images.height).toBeLessThanOrEqual(row.y);
  expect(images.y + images.height).toBeLessThanOrEqual(left.y);
  expect(images.x).toBeCloseTo(row.x, 0);
  await chat.snapshot('attachments-above-meta');
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(page.locator('#attachments')).toBeHidden();
  await expect(page.locator('#agent-label')).toHaveText('Agent: Build');
});

test('long context and billing details stay readable without horizontal overflow', async ({ page, chat }) => {
  await metadata(chat, false);
  await chat.send(
    { type: 'turnEnd', usage: { used: 135500, cost: { amount: 0.18, currency: 'USD' } } },
    { type: 'subagents', items: [], totalCost: 0.25 },
    { type: 'balance', balance: { amount: 12.40, currency: 'USD' } },
    { type: 'limits', limits: { go: { weekly: { resetsAt: 1893456000000 } } }, budget: { remaining: 10 } }
  );
  await expect(page.locator('#usage-cost')).toContainText('sub-agents');
  await expect(page.locator('#usage-cost')).toContainText('balance: $12.40');
  await expect(page.locator('#usage-reset')).toBeVisible();
  for (const selector of ['.usage-bar', '#usage', '.usage-details', '#usage-cost']) {
    expect(await page.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize().width);
  await chat.snapshot('long-composer-meta');
});

test('missing agent or billing does not shift the center context', async ({ page, chat }) => {
  await expect(page.locator('#agent-label')).toBeHidden();
  const row = await page.locator('.usage-bar').boundingBox();
  const center = await page.locator('#usage').boundingBox();
  expect(center.x + center.width / 2).toBeCloseTo(row.x + row.width / 2, 0);
});

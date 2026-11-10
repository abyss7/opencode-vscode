'use strict';

const { test, expect } = require('./fixture');

test('context meter has an exact descriptive tooltip and a separate compaction mark', async ({ page, chat }) => {
  await chat.send(
    { type: 'modelLimit', context: 1200000, input: 1000000 },
    { type: 'compaction', compaction: { auto: true, buffer: 20000 } },
    { type: 'cacheStats', prompt: 1200, read: 1152, at: Date.parse('2026-01-01T10:00:00Z') }
  );
  const meter = page.locator('#usage');
  const details = 'Context used: 1,200 tokens\nContext capacity: 1,000,000 tokens\nCached context: 1,152 tokens (96% of current context; measured 2 hours ago)';
  await expect(page.locator('#usage-tooltip')).toHaveText('context: 1.2k / 1M (96% cached 2 h ago) · compaction at 980k');
  await expect(meter).toHaveText('');
  await expect(meter).not.toHaveAttribute('title');
  await expect(meter).toHaveAttribute('aria-label', `${details}\nCompaction threshold: 980,000 tokens`);
  await expect(meter).toHaveAttribute('role', 'meter');
  await expect(meter).toHaveAttribute('aria-valuemax', '1000000');
  await expect(meter).toHaveAttribute('aria-valuenow', '1200');
  await expect(meter.locator('.usage-threshold')).toBeVisible();
  expect(await meter.evaluate((node) => parseFloat(node.style.getPropertyValue('--context-used')))).toBeCloseTo(0.12, 5);
  expect(await meter.evaluate((node) => parseFloat(node.style.getPropertyValue('--context-cached')))).toBeCloseTo(0.1152, 5);
  const track = await meter.locator('.usage-track').boundingBox();
  const mark = await meter.locator('.usage-threshold').boundingBox();
  expect((mark.x + mark.width / 2 - track.x) / track.width).toBeCloseTo(0.98, 3);
  await chat.send({ type: 'compaction', compaction: { auto: false } });
  await expect(meter).toHaveAttribute('aria-label', `${details}\nAutomatic compaction: disabled`);
  await expect(page.locator('#usage-tooltip')).toHaveText('context: 1.2k / 1M (96% cached 2 h ago)');
  await expect(meter.locator('.usage-threshold')).toBeHidden();
  await meter.focus();
  await expect(meter).toBeFocused();
});

test('billed tokens are not presented as context and unknown limits stay unknown', async ({ page, chat }) => {
  await chat.send({ type: 'turnEnd', usage: { totalTokens: 99000 } });
  const meter = page.locator('#usage');
  await expect(meter).toHaveAttribute('aria-label', 'Context used: unknown\nContext capacity: unknown');
  await expect(page.locator('#usage-tooltip')).toHaveText('context: —');
  await expect(meter).toHaveAttribute('role', 'img');
  await expect(meter.locator('.usage-threshold')).toBeHidden();
  await chat.send({ type: 'modelLimit', context: 1000000 });
  await expect(meter).toHaveAttribute('aria-label', 'Context used: unknown\nContext capacity: 1,000,000 tokens\nCompaction threshold: 850,000 tokens');
  await expect(page.locator('#usage-tooltip')).toHaveText('context: — / 1M · compaction at 850k');
  await expect(meter).not.toHaveAttribute('aria-valuenow');
  await chat.update({ sessionUpdate: 'usage_update', used: 0 });
  await expect(meter).toHaveAttribute('aria-label', 'Context used: 0 tokens\nContext capacity: 1,000,000 tokens\nCompaction threshold: 850,000 tokens');
  await expect(meter).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('#usage-tooltip')).toHaveText('context: 0 / 1M · compaction at 850k');
  expect(await meter.evaluate((node) => node.style.getPropertyValue('--context-used'))).toBe('0%');
});

test('the entire fill changes color by usage and cached prefix uses the capacity scale', async ({ page, chat }) => {
  await chat.send({ type: 'modelLimit', context: 300000 });
  const meter = page.locator('#usage');
  for (const [used, percent] of [[75000, 25], [150000, 50], [225000, 75], [300000, 100]]) {
    await chat.send({ type: 'cacheStats', prompt: used, read: used / 2 });
    const styles = await meter.evaluate((node) => ({
      used: parseFloat(node.style.getPropertyValue('--context-used')),
      cached: parseFloat(node.style.getPropertyValue('--context-cached')),
      color: getComputedStyle(node.querySelector('.usage-fill')).backgroundColor,
      image: getComputedStyle(node.querySelector('.usage-fill')).backgroundImage,
      clip: getComputedStyle(node.querySelector('.usage-fill')).clipPath,
      gray: getComputedStyle(node.querySelector('.usage-cache')).backdropFilter,
    }));
    expect(styles.used).toBe(percent);
    expect(styles.cached).toBe(percent / 2);
    expect(styles.color).toBe(percent >= 200 / 3 ? 'rgb(224, 108, 117)' : percent >= 100 / 3 ? 'rgb(214, 181, 77)' : 'rgb(70, 185, 130)');
    expect(styles.image).toBe('none');
    expect(styles.clip).toBe(`inset(0px ${100 - percent}% 0px 0px)`);
    expect(styles.gray).toBe('grayscale(0.65)');
    const track = await meter.locator('.usage-track').boundingBox();
    const cache = await meter.locator('.usage-cache').boundingBox();
    expect(cache.x).toBe(track.x);
    expect(cache.width / track.width).toBeCloseTo(percent / 200, 2);
    if (percent === 75) await chat.snapshot('context-meter-solid-red');
  }
});

test('fill color switches exactly at one third and two thirds in both directions', async ({ page, chat }) => {
  await chat.send({ type: 'modelLimit', context: 300000 });
  const fill = page.locator('#usage .usage-fill');
  for (const [used, color] of [
    [0, '70, 185, 130'], [99999, '70, 185, 130'],
    [100000, '214, 181, 77'], [100001, '214, 181, 77'], [199999, '214, 181, 77'],
    [200000, '224, 108, 117'], [200001, '224, 108, 117'], [400000, '224, 108, 117'],
    [199999, '214, 181, 77'], [99999, '70, 185, 130'],
  ]) {
    await chat.update({ sessionUpdate: 'usage_update', used });
    await expect(fill).toHaveCSS('background-color', `rgb(${color})`);
  }
  await chat.update({ sessionUpdate: 'usage_update', used: -1 });
  await expect(fill).toHaveCSS('background-color', 'rgb(70, 185, 130)');
});

test('meter width depends only on the interface, not model limits, usage or billing', async ({ page, chat }) => {
  const meter = page.locator('#usage');
  const initial = await meter.boundingBox();
  for (const capacity of [32000, 500000, 1200000]) {
    await chat.send(
      { type: 'modelLimit', context: capacity, input: capacity - 1000 },
      { type: 'cacheStats', prompt: capacity / 2, read: capacity / 4 },
      { type: 'turnEnd', usage: { cost: { amount: 123.45, currency: 'USD' } } },
      { type: 'subagents', items: [], totalCost: 98.76 }
    );
    const box = await meter.boundingBox();
    expect(box.width).toBeCloseTo(initial.width, 1);
    expect(box.x).toBeCloseTo(initial.x, 1);
  }
  await page.setViewportSize({ width: page.viewportSize().width > 700 ? 800 : 500, height: 900 });
  expect((await meter.boundingBox()).width).not.toBeCloseTo(initial.width, 1);
});

test('overflow is clamped visually without rounding the tooltip and resets clear stale cache', async ({ page, chat }) => {
  const meter = page.locator('#usage');
  await chat.send(
    { type: 'modelLimit', context: 100000 },
    { type: 'cacheStats', prompt: 150001, read: 150000 },
    { type: 'compaction', compaction: { buffer: -1000 } }
  );
  await expect(meter).toHaveAttribute('aria-label', /Context used: 150,001 tokens\nContext capacity: 100,000 tokens\nCached context: 150,000 tokens \(99\.999% of current context\)\nCompaction threshold: 101,000 tokens/);
  for (const name of ['used', 'cached', 'threshold']) {
    expect(await meter.evaluate((node, key) => node.style.getPropertyValue(`--context-${key}`), name)).toBe('100%');
  }
  await expect(meter).toHaveAttribute('aria-valuenow', '100000');
  await chat.send({ type: 'cacheStats', prompt: 60000, read: 90000 });
  expect(await meter.evaluate((node) => node.style.getPropertyValue('--context-cached'))).toBe('60%');
  await chat.send({ type: 'cacheStats', prompt: 0 });
  await chat.update({ sessionUpdate: 'usage_update', used: 25000, size: 200000 });
  await expect(meter).toHaveAttribute('aria-label', /^Context used: 25,000 tokens/);
  expect(await meter.evaluate((node) => node.style.getPropertyValue('--context-cached'))).toBe('0%');
  await chat.send({ type: 'modelLimit', context: 0, input: 0 });
  await expect(meter).toHaveAttribute('aria-valuemax', '200000');
  expect(await meter.evaluate((node) => node.style.getPropertyValue('--context-used'))).toBe('12.5%');
});

test('styled horizontal tooltip supports hover, keyboard, live updates and viewport bounds', async ({ page, chat }) => {
  await chat.send(
    { type: 'modelLimit', context: 1000000 },
    { type: 'cacheStats', prompt: 135500, read: 135290, at: Date.parse('2026-01-01T10:00:00Z') }
  );
  const meter = page.locator('#usage');
  const tooltip = page.locator('#usage-tooltip');
  await expect(tooltip).toBeHidden();
  await expect(meter).toHaveAttribute('aria-describedby', 'usage-tooltip');
  await meter.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('context: 135.5k / 1M (99.845% cached 2 h ago) · compaction at 850k');
  const bounds = async () => {
    const box = await tooltip.boundingBox();
    const bar = await meter.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(7);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width - 7);
    expect(box.y).toBeGreaterThanOrEqual(7);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
    expect(await tooltip.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  };
  await bounds();
  expect(await tooltip.evaluate((node) => getComputedStyle(node).fontFamily)).toBe(await meter.evaluate((node) => getComputedStyle(node).fontFamily));
  await chat.snapshot('context-horizontal-tooltip');
  await chat.send({ type: 'compaction', compaction: { auto: false } });
  await expect(tooltip).toHaveText('context: 135.5k / 1M (99.845% cached 2 h ago)');
  await page.setViewportSize({ width: 300, height: 900 });
  await meter.hover();
  await expect(tooltip).toBeVisible();
  await bounds();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await meter.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.locator('#input').focus();
  await meter.focus();
  await expect(tooltip).toBeVisible();
  await page.locator('#input').focus();
  await expect(tooltip).toBeHidden();
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

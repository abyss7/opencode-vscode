'use strict';

const { test, expect } = require('./fixture');
const tool = (chat, toolCallId, kind, rawInput, extra = {}) => chat.update({
  sessionUpdate: 'tool_call', toolCallId, kind, title: kind, rawInput, status: 'completed', ...extra,
});
const summary = (page) => page.locator('.turn-steps > summary');

test('summaries preserve steps and count unique files separately from tool totals', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect the files before updating them.' } });
  await tool(chat, 'read-a', 'read', { path: 'src/a.js' });
  await tool(chat, 'read-b', 'read', { path: 'src/b.js' });
  await tool(chat, 'read-again', 'read', { path: '/workspace/src/./a.js' });
  await tool(chat, 'patch', 'edit', { patchText: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-before\n+after\n*** Add File: src/c.js\n+created\n*** End Patch' });
  await tool(chat, 'run', 'execute', { command: 'npm run check' });
  await tool(chat, 'unknown', 'other', {});
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });

  await expect(summary(page).locator('.kind')).toHaveText('7 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Executed 6 tools', 'Read 2 files', 'Edited 2 files', 'Ran 1 command']);
  await expect(summary(page)).not.toContainText(/thought|other/);
  await chat.send({ type: 'turnStats', scope: 'last', turns: [{ steps: 20, kinds: ['thought', 'read', 'other'], tokens: 12345, cacheRead: 11000, cacheWrite: 0, exact: true }] });
  await expect(summary(page).locator('.kind')).toHaveText('20 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Executed 6 tools', 'Read 2 files', 'Edited 2 files', 'Ran 1 command']);
  await expect(summary(page).locator('.tokens')).toContainText('cache read');

  const box = await summary(page).boundingBox();
  const title = await summary(page).locator('.kind').boundingBox();
  const meta = await summary(page).locator('.name').boundingBox();
  const tokens = await summary(page).locator('.tokens').boundingBox();
  expect(tokens.x + tokens.width).toBeCloseTo(box.x + box.width, 0);
  if (page.viewportSize().width <= 600) {
    expect(meta.x).toBe(title.x);
    expect(meta.y).toBeGreaterThan(title.y);
  } else {
    expect(meta.x).toBeGreaterThan(title.x + title.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.turn-steps')).toHaveAttribute('open', '');
  const group = page.locator('.tool-group > summary');
  await expect(group).toHaveCount(6);
  await expect(group.locator('.step-metric')).toHaveCount(0);
  for (const step of await group.all()) await expect(step).toBeVisible();
  await group.first().click();
  await expect(page.locator('.tool-group').first()).toHaveAttribute('open', '');
  await expect(page.locator('.tool-group[open]')).toHaveCount(1);
  await chat.snapshot('step-summary-alignment');
});

test('pending and failed tools are not reported as successfully edited files', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'read', 'read', { path: 'src/a.js' });
  await tool(chat, 'edit', 'edit', { path: 'src/b.js' }, { status: 'in_progress' });
  await expect(summary(page).locator('.kind')).toHaveText('2 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Executing 2 tools', 'Read 1 file']);
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'failed' });
  await expect(summary(page).locator('.kind')).toHaveText('2 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Executed 2 tools', 'Read 1 file', '1 failed']);
  await tool(chat, 'no-path', 'read', {});
  await expect(summary(page).locator('.step-metric')).toHaveText(['Executed 3 tools', 'Read 2 times', '1 failed']);
});

test('thought-only details keep their step count without category enumeration', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Check the existing structure.' } });
  await expect(summary(page).locator('.kind')).toHaveText('1 step');
  await expect(summary(page).locator('.name')).toBeHidden();
  await expect(summary(page)).not.toContainText(/thought|other/);
});

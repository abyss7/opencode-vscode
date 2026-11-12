'use strict';

const { test, expect } = require('./fixture');
const { ProgressParser, matchingAdapters } = require('../../src/command-progress');
const card = (page, id) => page.locator('.tool-group').filter({ has: page.locator(`[data-tool-call-id="${id}"]`) });
const tool = (chat, id, extra = {}) => chat.update({ sessionUpdate: 'tool_call', toolCallId: id,
  kind: 'execute', title: 'shell', status: 'in_progress', rawInput: { command: 'echo before; ninja; echo after' }, ...extra });
const progress = (chat, id, text) => {
  const parser = new ProgressParser(matchingAdapters('ninja'));
  return chat.send({ type: 'commandProgress', items: [{ toolCallId: id, ...parser.feed(text) }] });
};

test('progress is a graphical inline addition, then the same command rejoins Steps', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'before', { status: 'completed' });
  await tool(chat, 'build');
  await tool(chat, 'after', { status: 'completed' });
  await progress(chat, 'build', '\r\x1b[2K[847/1203] CXX very-long-filename.cpp');
  const build = card(page, 'build');
  await expect(page.locator('#messages > .progress-task')).toHaveCount(1);
  await expect(build.locator('summary > .kind')).toHaveText('1 tool call');
  await expect(build.locator('summary > .name')).toBeHidden();
  await expect(build.getByRole('progressbar', { name: 'Ninja' })).toHaveAttribute('aria-valuenow', '847');
  await expect(build.locator('.command-progress-count')).toHaveText('847 / 1,203');
  await expect(build.locator('summary')).not.toContainText('very-long-filename');
  expect(await build.locator('.command-progress-fill').evaluate((node) => parseFloat(node.style.width))).toBeCloseTo(847 / 1203 * 100);
  const inline = await build.locator('summary').evaluate((summary) => {
    const kind = summary.querySelector('.kind').getBoundingClientRect();
    const progress = summary.querySelector('.command-progress').getBoundingClientRect();
    const fill = summary.querySelector('.command-progress-track').getBoundingClientRect();
    return { sameRow: Math.abs((kind.top + kind.height / 2) - (progress.top + progress.height / 2)) < 3,
      right: progress.left > kind.left, width: fill.width, height: fill.height };
  });
  expect(inline.sameRow).toBe(true); expect(inline.right).toBe(true);
  expect(inline.width).toBeGreaterThan(8); expect(inline.height).toBe(6);
  expect(await page.locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['before', 'build', 'after']);
  await chat.snapshot('inline-progress');
  await build.locator('summary').click();
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Build output' } }] });
  await expect(page.locator('#messages > .progress-task')).toHaveCount(0);
  await expect(page.locator('.turn-steps')).toHaveCount(1);
  await expect(build.getByRole('progressbar')).toHaveCount(0);
  await expect(build).toHaveAttribute('open', '');
  await expect(build.locator('.tool-row').filter({ hasText: 'OUT' })).toContainText('Build output');
  await expect(build.locator('summary > .name')).toHaveText('shell');
  // A delayed progress snapshot must not resurrect completed work.
  await progress(chat, 'build', '[1203/1203] done');
  await expect(page.locator('#messages > .progress-task')).toHaveCount(0);
});

test('background progress preserves status, output disclosure and the Stop control', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'background', { status: 'completed', background: { id: 'sh_bg', toolCallId: 'background' },
    rawInput: { command: 'ninja', background: true } });
  await chat.send({ type: 'background', runs: [{ id: 'sh_bg', toolCallId: 'background', status: 'running', output: '[7/10] CXX' }] });
  await progress(chat, 'background', '[7/10] CXX');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  const build = card(page, 'background');
  await expect(page.locator('#messages > .background-task.progress-task')).toHaveCount(1);
  await expect(build.locator('summary > .status')).toHaveText('in background');
  await expect(build.getByRole('button', { name: 'Stop background task' })).toBeVisible();
  await expect(build.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '7');
  const fits = await build.locator('summary').evaluate((summary) => {
    const nodes = ['.kind', '.command-progress', '.status', '.background-stop'].map((selector) => summary.querySelector(selector).getBoundingClientRect());
    return nodes.every((rect) => Math.abs(rect.top + rect.height / 2 - (nodes[0].top + nodes[0].height / 2)) < 4) &&
      summary.scrollWidth <= summary.clientWidth + 1 && nodes.every((rect, i) => i === 0 || rect.left >= nodes[i - 1].right);
  });
  expect(fits).toBe(true);
  await chat.snapshot('background-progress');
  await build.locator('summary').click();
  await expect(build.locator('.tool-row').filter({ hasText: 'OUT' })).toContainText('[7/10] CXX');
  await progress(chat, 'background', '[10/10] all tasks');
  await expect(build.getByRole('button', { name: 'Stop background task' })).toBeVisible();
  await expect(page.locator('#messages > .progress-task')).toHaveCount(1);
  await build.getByRole('button', { name: 'Stop background task' }).click();
  await expect(build.locator('summary > .status')).toHaveText('in background');
  await expect(build.getByRole('button', { name: 'Stop background task' })).toBeDisabled();
  expect(await chat.received('stopBackground')).toEqual([{ type: 'stopBackground', toolCallId: 'background' }]);
  await chat.send({ type: 'background', runs: [{ id: 'sh_bg', toolCallId: 'background', status: 'stopped', output: '[10/10] all tasks' }] });
  await expect(page.locator('.standalone-task')).toHaveCount(0);
  await expect(build.getByRole('progressbar')).toHaveCount(0);
  await expect(build.locator('summary > .status')).toHaveText('cancelled');
  await expect(build).toHaveAttribute('open', '');
});

test('progress survives a late foreground-to-background handoff without moving the command', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'build');
  await progress(chat, 'build', '[2/10] compile');
  await tool(chat, 'later', { status: 'completed' });
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'completed',
    background: { id: 'sh_handoff', toolCallId: 'build' } });
  await chat.send({ type: 'background', runs: [{ id: 'sh_handoff', toolCallId: 'build', status: 'running' }] });
  await expect(card(page, 'build').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  await expect(card(page, 'build').getByRole('button', { name: 'Stop background task' })).toBeVisible();
  expect(await page.locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['build', 'later']);
});

test('progress arriving before a tool card is attached when that active tool appears', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await progress(chat, 'restored', '[3/20] compile');
  await tool(chat, 'restored');
  await expect(page.locator('#messages > .progress-task')).toHaveCount(1);
  await expect(card(page, 'restored').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
  await chat.send({ type: 'commandProgress', items: [] });
  await expect(page.locator('.progress-task')).toHaveCount(0);
  await expect(page.locator('.turn-steps .tool-group')).toHaveCount(1);
});

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('./fixture');
const tool = (chat, id, background = false) => chat.update({ sessionUpdate: 'tool_call', toolCallId: id,
  title: 'shell', kind: 'execute', status: 'completed', rawInput: { command: `echo ${id}`, background },
  ...(background ? { background: { id: `sh_${id}`, toolCallId: id, status: 'unknown' } } : {}),
  content: [{ type: 'content', content: { type: 'text', text: `Result ${id}` } }],
});
const runs = (chat, ...items) => chat.send({ type: 'background', runs: items.map(([id, status = 'running']) =>
  ({ id: `sh_${id}`, toolCallId: id, status, output: `Output ${id}`, exit: 0 })) });
const card = (page, id) => page.locator('.tool-group').filter({ has: page.locator(`[data-tool-call-id="${id}"]`) });

test('background cards stay at launch positions outside Steps, including after completion', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'before'); await tool(chat, 'one', true); await tool(chat, 'between'); await tool(chat, 'two', true); await tool(chat, 'after');
  await runs(chat, ['one'], ['two']);
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.turn-steps .background-task')).toHaveCount(0);
  await expect(page.locator('#messages > .background-task')).toHaveCount(2);
  expect(await page.locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['before', 'one', 'between', 'two', 'after']);
  await expect(page.locator('#status-text')).toHaveText('Working in background');
  await expect(page.locator('#status')).toHaveClass('status background');
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('#header button')).toHaveCount(2); // Existing Artifacts and jump only.
  await card(page, 'one').locator('summary').click();
  await expect(card(page, 'one')).toHaveAttribute('open', '');
  await expect(card(page, 'one').locator('.tool-row').filter({ hasText: 'OUT' })).toContainText('Output one');
  await runs(chat, ['one', 'exited'], ['two', 'exited']);
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await expect(page.locator('#messages > .background-task')).toHaveCount(2);
  await expect(card(page, 'one').getByRole('button', { name: 'Stop background task' })).toBeHidden();
});

test('late background handoff splits Steps without reordering later tools', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'before'); await tool(chat, 'handoff'); await tool(chat, 'after');
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'handoff',
    background: { id: 'sh_handoff', toolCallId: 'handoff' }, status: 'completed' });
  await runs(chat, ['handoff']);
  await tool(chat, 'last');
  expect(await page.locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['before', 'handoff', 'after', 'last']);
  await expect(page.locator('#messages > .background-task')).toHaveCount(1);
  await expect(page.locator('.turn-steps')).toHaveCount(2);
  await expect(page.locator('.turn-steps .background-task')).toHaveCount(0);
});

test('whole-turn statistics do not group standalone background work back into Steps', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'ordinary'); await tool(chat, 'background', true);
  await runs(chat, ['background']);
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  const summary = page.locator('.turn-steps > summary > .kind');
  await expect(summary).toHaveText('1 step');
  await chat.send({ type: 'turnStats', scope: 'last', turns: [{ steps: 2, tokens: 100, exact: true }] });
  await expect(summary).toHaveText('1 step');
});

test('Stop is per card, keeps disclosure state, retries errors and retains output', async ({ page, chat }) => {
  await tool(chat, 'one', true); await tool(chat, 'two', true); await runs(chat, ['one'], ['two']);
  const first = card(page, 'one');
  const stop = first.getByRole('button', { name: 'Stop background task' });
  await stop.click();
  expect(await chat.received('stopBackground')).toEqual([{ type: 'stopBackground', toolCallId: 'one' }]);
  await expect(first).not.toHaveAttribute('open', '');
  await expect(stop).toBeDisabled();
  await expect(card(page, 'two').getByRole('button', { name: 'Stop background task' })).toBeEnabled();
  expect(await chat.received('cancel')).toEqual([]);
  await chat.send({ type: 'backgroundStopError', toolCallId: 'one', message: 'Connection lost' });
  await expect(stop).toBeEnabled();
  await first.locator('summary').click();
  await expect(first.getByRole('alert')).toHaveText('Connection lost');
  await stop.click();
  await runs(chat, ['one', 'stopped'], ['two']);
  await expect(stop).toBeHidden();
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('.background-state')).toHaveText('Stopped');
  await expect(first).toContainText('Output one');
});

test('working and attention outrank background; reduced motion keeps a static green dot', async ({ page, chat }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tool(chat, 'one', true); await runs(chat, ['one']);
  await expect(page.locator('#status-text')).toHaveText('Working in background');
  const dot = page.locator('#status .dot');
  const green = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--vscode-testing-iconPassed').trim());
  expect(await dot.evaluate((node, color) => { const probe = document.createElement('span'); probe.style.color = color;
    document.body.append(probe); const match = getComputedStyle(node).backgroundColor === getComputedStyle(probe).color; probe.remove(); return match; }, green)).toBe(true);
  expect(await dot.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await dot.evaluate((node) => getComputedStyle(node).animationName)).toBe('background-pulse');
  await chat.send({ type: 'status', state: 'busy' });
  await expect(page.locator('#status')).toHaveClass('status busy');
  await chat.send({ type: 'elicitation', requestId: 'q', message: 'Continue?', requestedSchema: { type: 'object', properties: {} } });
  await expect(page.locator('#status')).toHaveClass('status attention');
});

test('native replay and repeated updates preserve one background card and live output', async ({ page, chat }) => {
  const update = { toolCallId: 'one', kind: 'execute', title: 'shell', status: 'completed',
    rawInput: { command: 'echo one', background: true }, background: { id: 'sh_one', toolCallId: 'one' } };
  const message = { id: 'answer', type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'tool', update }] };
  await chat.send({ type: 'transcript', messages: [message] });
  await runs(chat, ['one']);
  await card(page, 'one').locator('summary').click();
  update.content = [{ type: 'content', content: { type: 'text', text: 'Background launcher output' } }];
  await chat.send({ type: 'transcript', messages: [message] });
  await expect(page.locator('#messages > .background-task')).toHaveCount(1);
  await expect(card(page, 'one')).toContainText('Output one');
  await expect(page.locator('.turn-steps .tool-entry')).toHaveCount(0);
});

test('sidebar background icon pulses, while working remains a spinner', async ({ page, chat }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test').replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scrollUri}}', 'https://opencode.test/media/scroll.js')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js')
    .replace('<title>', '<link rel="stylesheet" href="/theme.css"><title>');
  await page.route('https://opencode.test/', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://opencode.test/');
  const item = { kind: 'session', id: 'one', name: 'Background session', icon: 'terminal', children: [], actions: [] };
  await chat.send({ type: 'sessions', items: [item] });
  const icon = page.locator('.tree-icon-background');
  await expect(icon).toHaveCount(1);
  expect(await icon.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await icon.evaluate((node) => getComputedStyle(node).animationName)).toBe('background-pulse');
  await chat.send({ type: 'sessions', items: [{ ...item, icon: 'loading~spin' }] });
  await expect(icon).toHaveCount(0);
  await expect(page.locator('.tree-icon-busy')).toHaveCount(1);
});

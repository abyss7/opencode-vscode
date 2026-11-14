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

test('active background cards stay in place and completed commands rejoin ordinary Steps', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'before'); await tool(chat, 'one', true); await tool(chat, 'between'); await tool(chat, 'two', true); await tool(chat, 'after');
  await runs(chat, ['one'], ['two']);
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.turn-steps .background-task')).toHaveCount(0);
  await expect(page.locator('#messages > .background-task')).toHaveCount(2);
  expect(await page.locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['before', 'one', 'between', 'two', 'after']);
  await expect(page.locator('#status-text')).toHaveText('Working in background…');
  await expect(page.locator('#status')).toHaveClass('status background');
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('#header button')).toHaveCount(2); // Existing Artifacts and jump only.
  await expect(card(page, 'one').locator('summary > .kind')).toHaveText('Ran 1 command');
  await expect(card(page, 'one').locator('summary > .name')).toHaveText('shell');
  await expect(card(page, 'one').locator('summary > .status')).toHaveText('in background');
  await card(page, 'one').locator('summary').click();
  await expect(card(page, 'one')).toHaveAttribute('open', '');
  await expect(card(page, 'one').locator('.tool-row').filter({ hasText: 'OUT' })).toContainText('Output one');
  await runs(chat, ['one', 'exited'], ['two', 'exited']);
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await expect(page.locator('.background-task')).toHaveCount(0);
  await expect(page.locator('.turn-steps')).toHaveCount(1);
  await expect(page.locator('.turn-steps > summary > .kind')).toHaveText('5 steps');
  await expect(card(page, 'one').locator('summary > .kind')).toHaveText('Ran 1 command');
  await expect(card(page, 'one').locator('summary > .status')).toHaveText('done');
  expect(await page.locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['before', 'one', 'between', 'two', 'after']);
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

test('a background split never bounces the running turn into its chevron', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'before'); await tool(chat, 'handoff'); await tool(chat, 'after');
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'handoff',
    background: { id: 'sh_handoff', toolCallId: 'handoff' }, status: 'completed' });
  await runs(chat, ['handoff']);
  // Both halves of the split keep streaming raw: no chevron appears mid-turn.
  await expect(page.locator('.turn-steps.live')).toHaveCount(2);
  await expect(page.locator('.turn-steps.live').first()).toHaveAttribute('open', '');
  for (const chevron of await page.locator('.turn-steps > summary').all()) {
    await expect(chevron).toBeHidden();
  }
  // The background command finishing rejoins the halves without folding them.
  await runs(chat, ['handoff', 'exited']);
  await expect(page.locator('.turn-steps')).toHaveCount(1);
  await expect(page.locator('.turn-steps.live')).toHaveCount(1);
  await expect(page.locator('.turn-steps > summary')).toBeHidden();
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.turn-steps.live')).toHaveCount(0);
  await expect(page.locator('.turn-steps')).not.toHaveAttribute('open', '');
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
  await expect(stop).toHaveText('');
  await expect(stop.locator('svg rect')).toHaveCount(1);
  const size = await stop.boundingBox();
  expect(size.width).toBe(20);
  expect(size.height).toBe(20);
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
  await expect(first.locator('summary > .status')).toHaveText('cancelled');
  await expect(first.locator('.background-state')).toHaveCount(0);
  await expect(first).toContainText('Output one');
});

test('completed background replay is ordinary collapsible work and retains exact turn statistics', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await runs(chat, ['old', 'exited']);
  await tool(chat, 'old', true);
  await tool(chat, 'ordinary');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.background-task')).toHaveCount(0);
  await expect(page.locator('.turn-steps')).toHaveCount(1);
  await expect(card(page, 'old').locator('summary > .kind')).toHaveText('Ran 1 command');
  await expect(card(page, 'old').locator('summary > .status')).toHaveText('done');
  await expect(card(page, 'old').locator('summary > .background-stop')).toHaveCount(0);
  // The turn settled: the block starts collapsed and behaves as ordinary history.
  await expect(page.locator('.turn-steps')).not.toHaveAttribute('open', '');
  await page.locator('.turn-steps > summary').click();
  await expect(card(page, 'old')).toBeVisible();
  await page.locator('.turn-steps > summary').click();
  await expect(card(page, 'old')).toBeHidden();
  await page.locator('.turn-steps > summary').click();
  await card(page, 'old').locator('summary').click();
  await expect(card(page, 'old')).toContainText('Output old');
  await chat.send({ type: 'turnStats', scope: 'last', turns: [{ steps: 2, tokens: 12345, exact: true }] });
  const tokens = await page.locator('.turn-steps > summary > .tokens').textContent();
  await runs(chat, ['old', 'exited']);
  await expect(page.locator('.turn-steps > summary > .tokens')).toHaveText(tokens);
});

test('out-of-order completion never groups across answers or later turns', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'first', true); await tool(chat, 'second', true);
  await runs(chat, ['first'], ['second']);
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First answer' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'later');
  await runs(chat, ['first'], ['second', 'exited']);
  await runs(chat, ['first', 'exited'], ['second', 'exited']);
  await tool(chat, 'latest');
  await expect(page.locator('.turn-steps')).toHaveCount(2);
  expect(await page.locator('.turn-steps').first().locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['first', 'second']);
  expect(await page.locator('.turn-steps').last().locator('.tool-entry').evaluateAll((nodes) => nodes.map((node) => node.dataset.toolCallId)))
    .toEqual(['later', 'latest']);
});

test('background failure uses ordinary failed command styling instead of claiming success', async ({ page, chat }) => {
  await tool(chat, 'fail', true);
  await chat.send({ type: 'background', runs: [{ id: 'sh_fail', toolCallId: 'fail', status: 'exited', exit: 7, output: 'Command failed' }] });
  await expect(card(page, 'fail').locator('summary > .status')).toHaveText('failed');
  await expect(card(page, 'fail').locator('summary > .status')).toHaveClass('status failed');
  await expect(card(page, 'fail').locator('summary > .kind')).not.toHaveText('Ran 1 command');
  await expect(page.locator('.turn-steps .tool-entry')).toHaveCount(1);
  await expect(page.locator('.background-task')).toHaveCount(0);
});

test('in-background labels pulse in phase with the header, even when added later', async ({ page, chat }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await tool(chat, 'first', true); await runs(chat, ['first']);
  const dot = page.locator('#status .dot');
  await expect.poll(() => dot.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeLessThan(.7);
  await tool(chat, 'second', true); await runs(chat, ['first'], ['second']);
  const phase = await page.evaluate(() => [...document.querySelectorAll('#status .dot, .background-state')].map((node) => ({
    opacity: Number(getComputedStyle(node).opacity), start: node.getAnimations()[0].startTime,
  })));
  expect(phase).toHaveLength(3);
  for (const value of phase.slice(1)) {
    expect(value.start).toBe(phase[0].start);
    expect(value.opacity).toBeCloseTo(phase[0].opacity, 3);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.background-state').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName)))
    .toEqual(['none', 'none']);
});

test('working and attention outrank background; reduced motion keeps a static green dot', async ({ page, chat }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tool(chat, 'one', true); await runs(chat, ['one']);
  await expect(page.locator('#status-text')).toHaveText('Working in background…');
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

test('background header counts active commands and ticks from the oldest active start', async ({ page, chat }) => {
  const first = { id: 'sh_one', toolCallId: 'one', status: 'running', time: { started: Date.parse('2026-01-01T11:58:37Z') } };
  const second = { id: 'sh_two', toolCallId: 'two', status: 'running', time: { started: Date.parse('2026-01-01T11:59:30Z') } };
  const finished = { id: 'sh_old', toolCallId: 'old', status: 'exited', time: { started: 1 } };
  const operation = page.locator('#activity-operation');
  await chat.send({ type: 'background', runs: [finished, first, second] });
  await expect(page.locator('#status-text')).toHaveText('Working in background…');
  await expect(page.locator('#activity-detail')).toBeVisible();
  await expect(operation).toHaveText('running 2 commands for 1m 23s');
  await page.clock.setFixedTime(new Date('2026-01-01T12:00:02Z'));
  // No server update: the existing live clock must tick on its own.
  await expect(operation).toHaveText('running 2 commands for 1m 25s');
  await chat.send({ type: 'background', runs: [{ ...first, status: 'exited' }, second] });
  await expect(operation).toHaveText('running 1 command for 32s');
  await chat.send({ type: 'status', state: 'busy' });
  await expect(operation).not.toContainText('command');
  await chat.send({ type: 'status', state: 'ready' });
  await expect(operation).toHaveText('running 1 command for 32s');
  await chat.send({ type: 'background', runs: [] });
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await expect(page.locator('#activity-detail')).toBeHidden();
});

test('sidebar background icon pulses, while working remains a spinner', async ({ page, chat }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test').replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scrollUri}}', 'https://opencode.test/media/scroll.js')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js')
    .replaceAll('{{timeUri}}', 'https://opencode.test/media/time.js')
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
  await expect.poll(() => icon.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeLessThan(.65);
  const phase = await page.evaluate((item) => {
    const oldIcon = document.querySelector('.tree-icon-background');
    const before = { opacity: Number(getComputedStyle(oldIcon).opacity), start: oldIcon.getAnimations()[0].startTime };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessions', items: [{ ...item, name: 'Updated session' }] } }));
    const newIcon = document.querySelector('.tree-icon-background');
    return { before, after: { opacity: Number(getComputedStyle(newIcon).opacity), start: newIcon.getAnimations()[0].startTime } };
  }, item);
  await expect(page.locator('.tree-label')).toHaveText('Updated session');
  expect(phase.before.start).not.toBeNull();
  expect(phase.after.start).toBe(phase.before.start);
  expect(phase.after.opacity).toBeCloseTo(phase.before.opacity, 3);
  await chat.send({ type: 'sessions', items: [{ ...item, icon: 'loading~spin' }] });
  await expect(icon).toHaveCount(0);
  await expect(page.locator('.tree-icon-busy')).toHaveCount(1);
});

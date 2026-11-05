'use strict';

const { test, expect } = require('./fixture');
const busy = (chat) => chat.send({ type: 'status', state: 'busy' });
const text = (chat, value) => chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const tool = (chat, value) => chat.update({ sessionUpdate: 'tool_call_update', ...value });
const at = (page, value) => page.clock.setFixedTime(new Date(`2026-01-01T12:${value}Z`));
const question = (requestId) => ({ type: 'elicitation', requestId, message: 'Which layout should be used?', requestedSchema: { type: 'object', properties: {} } });

test('header height and right controls stay fixed when artifacts and activity appear', async ({ page, chat }) => {
  const header = page.locator('#header');
  const view = page.getByRole('button', { name: 'View options' });
  const jump = page.getByRole('button', { name: 'Jump to current message' });
  const artifacts = page.locator('#artifacts-toggle');
  const initial = { header: await header.boundingBox(), view: await view.boundingBox(), jump: await jump.boundingBox() };
  expect(initial.header.height).toBe(42);
  expect(initial.view.width).toBe(initial.view.height);
  await expect(artifacts).toBeHidden();
  await expect(page.locator('#activity-detail')).toBeHidden();

  await busy(chat);
  await tool(chat, { toolCallId: 'run', kind: 'execute', title: 'Implementing ' + 'the activity header '.repeat(30), status: 'in_progress', rawInput: { command: 'npm run check' } });
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#header #stop')).toHaveCount(0);
  await expect(page.locator('.turn-steps .live')).toHaveCount(0);
  const artifact = { schema: 1, id: 'layout', version: 1, title: 'Layout', kind: 'markdown', content: 'Header layout' };
  await text(chat, '```opencode-artifact\n' + JSON.stringify(artifact) + '\n```');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(artifacts).toBeVisible();
  await expect(artifacts).toHaveText('Artifacts');
  expect(await artifacts.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  expect(await jump.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  expect(await view.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  expect((await artifacts.boundingBox()).x).toBeLessThan(initial.view.x);

  await busy(chat);
  await chat.send(question('q'));
  await expect(page.locator('#status')).toHaveClass('status attention');
  expect(await header.boundingBox()).toEqual(initial.header);
  expect(await view.boundingBox()).toEqual(initial.view);
  expect(await jump.boundingBox()).toEqual(initial.jump);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await view.click();
  await expect(page.locator('#view-options')).toBeVisible();
  expect(await header.boundingBox()).toEqual(initial.header);
  await view.click();
  await chat.snapshot('activity-with-controls');
});

test('operation clocks survive partial updates and switching between concurrent tools', async ({ page, chat }) => {
  await busy(chat);
  await chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Implementing the activity header', status: 'in_progress' }] });
  await tool(chat, { toolCallId: 'run', kind: 'execute', title: 'Checking changes', status: 'in_progress', rawInput: { command: 'npm run check' } });
  await at(page, '01:23');
  await tool(chat, { toolCallId: 'run', status: 'in_progress' });
  await expect(page.locator('#status-text')).toHaveText('Implementing the activity header');
  await expect(page.locator('#activity-operation')).toHaveText('run for 1m 23s');
  await expect(page.locator('#activity-target')).toHaveText('npm run check');
  await tool(chat, { toolCallId: 'edit', kind: 'edit', title: 'Editing styles', status: 'in_progress', rawInput: { path: 'media/chat.css' } });
  await at(page, '01:28');
  await expect(page.locator('#activity-operation')).toHaveText('edit for 5s');
  await tool(chat, { toolCallId: 'edit', status: 'completed' });
  await expect(page.locator('#activity-operation')).toHaveText('run for 1m 28s');
  await expect(page.locator('#activity-target')).toHaveText('npm run check');
  await tool(chat, { toolCallId: 'run', status: 'completed' });
  await expect(page.locator('#activity-operation')).toHaveText('working for 0s');
  await text(chat, 'Done.');
  await expect(page.locator('#activity-operation')).toHaveText('write for 0s');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await expect(page.locator('#activity-detail')).toBeHidden();
});

test('attention takes priority and the arrow targets the first unanswered request', async ({ page, chat }) => {
  await busy(chat);
  await text(chat, ('Previous output.\n\n').repeat(80));
  await tool(chat, { toolCallId: 'run', kind: 'execute', title: 'Checking changes', status: 'in_progress', rawInput: { command: 'npm run check' } });
  await chat.send(question('q'));
  await at(page, '00:30');
  await chat.send({ type: 'permission', requestId: 'p', toolCall: { title: 'Read a file', kind: 'read', rawInput: { path: 'media/chat.css' } }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] });
  await at(page, '00:42');
  await busy(chat);
  await expect(page.locator('#status-text')).toHaveText('Waiting for your answer');
  await expect(page.locator('#activity-operation')).toHaveText('question for 42s');
  await page.locator('#messages').evaluate((el) => { el.style.scrollBehavior = 'auto'; el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await expect(page.locator('.elicitation')).toBeInViewport();
  await expect(page.locator('.elicitation .allow')).toBeFocused();
  await page.locator('.elicitation .allow').click();
  await expect(page.locator('#status-text')).toHaveText('Waiting for approval');
  await expect(page.locator('#activity-operation')).toHaveText('permission for 12s');
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeFocused();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.locator('#status')).toHaveClass('status busy');
  await expect(page.locator('#activity-operation')).toHaveText('run for 42s');
});

test('thinking, errors and history reset do not leave a stale running header', async ({ page, chat }) => {
  await busy(chat);
  await chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect the current styles.' } });
  await expect(page.locator('#status-text')).toHaveText('Thinking…');
  await expect(page.locator('#activity-operation')).toHaveText('think for 0s');
  await chat.send(question('q'));
  await chat.send({ type: 'error', message: 'Connection lost' });
  await expect(page.locator('#status')).toHaveClass('status error');
  await expect(page.locator('#activity-detail')).toBeHidden();
  await expect(page.locator('#input')).toBeEnabled();
  await chat.send({ type: 'historyReset' }, { type: 'status', state: 'ready' });
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await busy(chat);
  await expect(page.locator('#status-text')).toHaveText('Working…');
  await expect(page.locator('#activity-operation')).toHaveText('working for 0s');
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await chat.send({ type: 'status', state: 'cancelling' });
  await expect(page.locator('#status-text')).toHaveText('Stopping…');
  await chat.send({ type: 'turnEnd', stopReason: 'cancelled' });
  await expect(page.locator('#activity-detail')).toBeHidden();
});

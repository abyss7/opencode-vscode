'use strict';

const { test, expect } = require('./fixture');
const thought = (chat, text, messageId) => chat.update({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } });
const tool = (chat, toolCallId, rawInput, title = 'Read file media/chat.js', kind = 'read') => chat.update({
  sessionUpdate: 'tool_call', toolCallId, rawInput, title, kind, status: 'in_progress',
});
const caption = (page) => page.locator('#status-text');

test('completed thought headings survive tool changes without showing partial headings', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await thought(chat, '**Implementing the activity');
  await expect(caption(page)).toHaveText('Thinking…');
  await thought(chat, ' header**');
  await expect(caption(page)).toHaveText('Thinking…');
  await thought(chat, '\n\n' + 'Detailed reasoning. '.repeat(40));
  await expect(caption(page)).toHaveText('Implementing the activity header');
  await tool(chat, 'read', { path: 'media/chat.js' });
  await expect(caption(page)).toHaveText('Implementing the activity header');
  await expect(page.locator('#activity-target')).toHaveText('media/chat.js');
  await tool(chat, 'run', { command: 'npm run check', description: 'Checking the UI changes' }, 'shell', 'execute');
  await expect(caption(page)).toHaveText('Implementing the activity header');
  await thought(chat, '## Verifying the new layout\nMore details.');
  await expect(caption(page)).toHaveText('Verifying the new layout');
});

test('a short plain thought is used only after its block has finished', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await thought(chat, 'Inspecting the header layout.', 'thought-1');
  await expect(caption(page)).toHaveText('Thinking…');
  await tool(chat, 'read', { path: 'media/chat.js' });
  await expect(caption(page)).toHaveText('Inspecting the header layout.');
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
  await expect(caption(page)).toHaveText('Inspecting the header layout.');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' }, { type: 'status', state: 'busy' });
  await expect(caption(page)).toHaveText('Working…');
});

test('long unstructured reasoning and headings inside code fences are not captions', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await thought(chat, 'I need to inspect this');
  await expect(caption(page)).toHaveText('Thinking…');
  await thought(chat, ' carefully. '.repeat(50) + '\n```md\n## Not an activity\n```\n## Analysis\n');
  await expect(caption(page)).toHaveText('Thinking…');
  await tool(chat, 'read', { path: 'media/chat.js' });
  await expect(caption(page)).toHaveText('Working…');
  await thought(chat, '## ' + 'Very long heading '.repeat(12) + '\n');
  await expect(caption(page)).toHaveText('Thinking…');
  await tool(chat, 'next-read', { path: 'media/chat.js' });
  await expect(caption(page)).toHaveText('Working…');
});

test('fallbacks use plan and tool purpose, not a duplicate command or path', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'raw', { command: 'npm run check' }, 'npm run check', 'execute');
  await expect(caption(page)).toHaveText('Working…');
  await tool(chat, 'purpose', { command: 'npm run check', description: 'Checking the UI changes' }, 'shell', 'execute');
  await expect(caption(page)).toHaveText('Checking the UI changes');
  await tool(chat, 'read', { path: 'media/chat.js' });
  await expect(caption(page)).toHaveText('Checking the UI changes');
  await chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Verify the interface', status: 'in_progress' }] });
  await expect(caption(page)).toHaveText('Verify the interface');
  await thought(chat, '**Reviewing keyboard navigation**\n');
  await expect(caption(page)).toHaveText('Reviewing keyboard navigation');
  await chat.send({ type: 'elicitation', requestId: 'q', message: 'Choose a layout', requestedSchema: { type: 'object', properties: {} } });
  await expect(caption(page)).toHaveText('Waiting for your answer');
  await page.locator('.elicitation .allow').click();
  await expect(caption(page)).toHaveText('Reviewing keyboard navigation');
  await chat.send({ type: 'historyReset' }, { type: 'status', state: 'ready' }, { type: 'status', state: 'busy' });
  await expect(caption(page)).toHaveText('Working…');
});

test('thought message boundaries finalize short captions and replay does not leak them', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await thought(chat, 'Inspecting the current layout.', 'one');
  await thought(chat, 'This next thought is still streaming', 'two');
  await expect(caption(page)).toHaveText('Inspecting the current layout.');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' }, { type: 'historyReset' });
  await thought(chat, '**Old activity**\n', 'history');
  await chat.send({ type: 'historyEnd' }, { type: 'status', state: 'busy' });
  await expect(caption(page)).not.toHaveText('Old activity');
});

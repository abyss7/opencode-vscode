'use strict';

const { test, expect } = require('./fixture');
const { watchRootScroll, scrollTranscript, expectInside } = require('./root-scroll');
const text = (chat, text) => chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
async function history(chat) {
  await text(chat, 'Earlier answer.\n\n'.repeat(100));
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}

test('plan navigation scrolls the transcript, not its ancestors', async ({ page, chat }) => {
  await history(chat);
  await chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Check scrolling', status: 'in_progress' }] });
  await scrollTranscript(page, false);
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Show plan' }).click();
  await stable();
  await expect(page.locator('.plan > summary')).toBeFocused();
  await expectInside(page.locator('.plan > summary'), page.locator('#messages'));
});

test('current-action navigation reveals the last tool without moving the composer', async ({ page, chat }) => {
  await history(chat);
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'current', kind: 'read', title: 'Read current file', status: 'in_progress' });
  await scrollTranscript(page, false);
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await stable();
  await expectInside(page.locator('.tool-group > summary'), page.locator('#messages'));
});

test('permission navigation reveals and focuses the requested action inside the transcript', async ({ page, chat }) => {
  await history(chat);
  await chat.send({ type: 'permission', requestId: 'approval', toolCall: { title: 'Read a file', kind: 'read' },
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] });
  await scrollTranscript(page, false);
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await stable();
  const allow = page.getByRole('button', { name: 'Allow once' });
  await expect(allow).toBeFocused();
  await expectInside(allow, page.locator('#messages'));
});

test('question navigation and composer focus stay inside the question footer', async ({ page, chat }) => {
  await history(chat);
  await chat.send({ type: 'elicitation', requestId: 'question', message: 'Please answer.', requestedSchema: {
    type: 'object', properties: { answer: { type: 'string', title: 'Answer' } },
  } });
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await stable();
  await expect(page.locator('#questions input').first()).toBeFocused();
  await page.locator('#activity-jump').focus();
  await chat.send({ type: 'focus', preserveScroll: true });
  await stable();
  await expect(page.locator('#questions input').first()).toBeFocused();
});

test('answer outline navigates to the last heading without scrolling the document', async ({ page, chat }) => {
  await text(chat, Array.from({ length: 4 }, (_, i) => `## Section ${i + 1}\n\n${i === 3 ? 'End.' : 'Paragraph.\n\n'.repeat(40)}\n\n`).join(''));
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await scrollTranscript(page, false);
  await page.locator('.answer-outline > summary').click();
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Section 4', exact: true }).click();
  await stable();
  const heading = page.getByRole('heading', { name: 'Section 4' });
  await expect(heading).toBeFocused();
  await expectInside(heading, page.locator('#messages'));
});

test('artifact message navigation and closing the inspector preserve the document position', async ({ page, chat }) => {
  await history(chat);
  await text(chat, '```opencode-artifact\n' + JSON.stringify({ schema: 1, id: 'scroll', version: 1,
    title: 'Scroll example', kind: 'markdown', content: 'Artifact body.' }) + '\n```');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  await scrollTranscript(page, false);
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Go to message' }).click();
  await stable();
  const reference = page.locator('.artifact-reference button');
  await expect(reference).toBeFocused();
  await expectInside(reference, page.locator('#messages'));
  await page.getByRole('button', { name: 'Close artifacts' }).click();
  await stable();
  await expect(page.locator('#artifacts-toggle')).toBeFocused();
});

test('model navigation, selection and focus restoration scroll only the model list', async ({ page, chat }) => {
  const config = { type: 'config', configOptions: [{ id: 'model', category: 'model', name: 'Model', type: 'select',
    currentValue: 'openai/model-0', options: Array.from({ length: 80 }, (_, i) => ({ value: `openai/model-${i}`, name: `Model ${i}` })) }] };
  await chat.send(config);
  const stable = await watchRootScroll(page);
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await model.press('End');
  await stable();
  await expectInside(page.getByRole('option').last(), page.getByRole('listbox', { name: 'Models' }));
  await model.press('Home');
  await stable();
  await expectInside(page.getByRole('option').first(), page.getByRole('listbox', { name: 'Models' }));
  await model.press('End');
  await model.press('Enter');
  await chat.send({ ...config, configOptions: [{ ...config.configOptions[0], currentValue: 'openai/model-79' }] });
  await stable();
  await expect(model).toBeFocused();
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('openai/model-79');
});

test('bottom jump, composer focus, typing and sending leave the root document stationary', async ({ page, chat }) => {
  await history(chat);
  await scrollTranscript(page, false);
  const stable = await watchRootScroll(page);
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await stable();
  expect(await page.locator('#messages').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  await chat.send({ type: 'focus' });
  await stable();
  await expect(page.locator('#input')).toBeFocused();
  await page.locator('#input').fill('Next question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await stable();
  await expect(page.locator('#input')).toBeFocused();
  expect((await chat.received('prompt')).at(-1).text).toBe('Next question');
});

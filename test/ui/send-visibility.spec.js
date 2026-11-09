'use strict';

const { test, expect } = require('./fixture');
const { expectInside, watchRootScroll } = require('./root-scroll');

const gap = (page) => page.locator('#messages').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);

async function answerHistory(chat) {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'earlier', content: { type: 'text', text: 'Earlier question' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer.\n\n' + 'Paragraph.\n\n'.repeat(120) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}

async function readFromTop(page) {
  await page.locator('#messages').evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => page.locator('#messages').evaluate(node => node.scrollTop)).toBe(0);
}

test('sending reveals the new message while an earlier answer is being read', async ({ page, chat }) => {
  await answerHistory(chat);
  await readFromTop(page);
  const input = page.locator('#input');
  await input.fill('Follow-up question');
  // Revealing the sent turn must stay inside the transcript: the document and
  // the composer keep their position, exactly like every other navigation.
  const stable = await watchRootScroll(page, '#composer', { forceOverflow: false });
  await input.press('Enter');

  expect(await chat.received('prompt')).toEqual([{ type: 'prompt', text: 'Follow-up question', images: [] }]);
  const sent = page.locator('.message.user').last();
  await expect(sent).toContainText('Follow-up question');
  await stable();
  await expectInside(sent, page.locator('#messages'));
  await expect.poll(() => gap(page)).toBeLessThan(2);

  // The sent turn started a response, so its rendered answer stays visible too.
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Streaming answer.\n\n'.repeat(40) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await stable();
  await expectInside(page.locator('.message.assistant').last(), page.locator('#messages'));
  await expect.poll(() => gap(page)).toBeLessThan(2);
});

test('a queued submission is revealed after sending in a server-backed session', async ({ page, chat }) => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `msg_${index}`, type: 'user', text: `Message ${index}\n${'Long message '.repeat(15)}`,
    time: { created: 1767268800000 },
  }));
  await chat.send({ type: 'transcript', messages, inbox: [], states: [] }, { type: 'historyEnd' });
  await readFromTop(page);
  await page.locator('#input').fill('Queued follow-up');
  await page.locator('#input').press('Enter');

  const queued = page.locator('.queued-input');
  await expect(queued).toContainText('Queued follow-up');
  await expectInside(queued, page.locator('#messages'));
  await expect.poll(() => gap(page)).toBeLessThan(2);
});

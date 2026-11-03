'use strict';

const { test, expect } = require('./fixture');
const { withClientContext } = require('../../src/client-context');

test('restored prompts display the user text, including chunked context', async ({ page, chat }) => {
  const text = withClientContext('Explain this architecture.');
  const split = text.indexOf('This VS Code');
  for (const chunk of [text.slice(0, split), text.slice(split)]) {
    await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'user-1', content: { type: 'text', text: chunk } });
  }
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.user .body')).toHaveText('Explain this architecture.');
  await expect(page.locator('#messages')).not.toContainText('opencode-client-context');
  await chat.send({ type: 'historyReset' });
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'user-1', content: { type: 'text', text } });
  await chat.send({ type: 'historyEnd' });
  await expect(page.locator('.message.user .body')).toHaveText('Explain this architecture.');
});

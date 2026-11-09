'use strict';

const { test, expect } = require('./fixture');

test('compact latest prompt sticks while the full message remains in the transcript', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Keep this question visible' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.locator('#messages').evaluate((node) => { node.style.scrollBehavior = 'auto'; node.scrollTop = 500; });
  const top = await page.locator('#messages').evaluate((node) => node.getBoundingClientRect().top);
  await expect(page.getByRole('button', { name: 'Go to latest prompt' })).toBeVisible();
  await expect.poll(async () => (await page.locator('.sticky-prompt button').boundingBox()).y).toBeCloseTo(top, 0);
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 900; });
  await expect.poll(async () => (await page.locator('.sticky-prompt button').boundingBox()).y).toBeCloseTo(top, 0);
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(async () => (await page.locator('.message.user').boundingBox()).y).toBeCloseTo(top + 16, 0);
  await expect(page.locator('.sticky-prompt button')).toBeHidden();
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'Next question' } });
  await expect(page.locator('.message.user').first()).toHaveCSS('position', 'static');
  await expect(page.locator('.message.user').last()).toHaveCSS('position', 'static');
  await expect(page.locator('.sticky-prompt')).toHaveCount(1);
  await expect(page.locator('.sticky-prompt button')).toHaveText('Next question');
});

test('bottom collapse survives streamed output and returns focus to its summary', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'collapse-tool', title: 'Read output', kind: 'read', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'First result' } }] });
  const details = page.locator('details.tool-group');
  await page.locator('details.turn-steps > summary').click();
  await details.locator(':scope > summary').click();
  const collapse = details.locator(':scope > .disclosure-collapse');
  await expect(collapse).toBeVisible();
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'collapse-tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Updated result' } }] });
  await expect(collapse).toHaveCount(1);
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(details).not.toHaveAttribute('open', '');
  await expect(details.locator(':scope > summary')).toBeFocused();
  await expect(collapse).toBeHidden();
});

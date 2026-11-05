'use strict';

const { test, expect } = require('./fixture');

test('unconfirmed execution stops the clock and allows an explicit continuation', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await expect(page.locator('#activity-detail')).toBeVisible();
  await chat.send({ type: 'status', state: 'unconfirmed', message: 'Execution unconfirmed — this session may be suspended or running in another OpenCode process.' });
  await expect(page.locator('#status')).toHaveClass('status unconfirmed');
  await expect(page.locator('#status-text')).toContainText('Execution unconfirmed');
  await expect(page.locator('#activity-detail')).toBeHidden();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.getByPlaceholder('Send a message to continue…')).toBeEnabled();
});

test('external ownership is shown without inventing live progress or elapsed time', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy', external: true,
    message: 'Server reports active execution — live progress is unavailable in this tab.' });
  await expect(page.locator('#status')).toHaveClass('status busy');
  await expect(page.locator('#status-text')).toContainText('live progress is unavailable');
  await expect(page.locator('#activity-detail')).toBeHidden();
  await expect(page.locator('#stop')).toBeVisible();
  await chat.send({ type: 'status', state: 'busy' });
  await expect(page.locator('#activity-detail')).toBeVisible();
  await expect(page.locator('#status-text')).toHaveText('Working…');
});

test('replaying a synthetic-only continuation does not invent an empty user bubble', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'resume-input', content: { type: 'text', text: '' } });
  await expect(page.locator('.message.user')).toHaveCount(0);
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'real-input', content: { type: 'text', text: 'Continue with the next task' } });
  await expect(page.locator('.message.user')).toHaveCount(1);
});

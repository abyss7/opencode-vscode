'use strict';

const { test, expect } = require('./fixture');

const text = 'Продолжить <задачу> & "обсуждение"';
test.use({ initialState: {
  sessionId: 'ses_visual_fixture', cwd: '/workspace',
  submissions: [{ id: 'msg_migrated', state: 'sending', item: {
    id: 'msg_migrated', type: 'user', payload: { text }, time: { created: 1767268801000 },
  } }],
} });

test('legacy tab migration preserves pending input without resubmitting it', async ({ page, chat }) => {
  await expect(page.locator('.queued-input')).toContainText(text);
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Delivery unconfirmed');
  expect(await chat.received('prompt')).toEqual([]);
});

test('a migrated webview reload keeps newer saved state', async ({ page, chat }) => {
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem('vscode-state'));
    state.submissions = [];
    sessionStorage.setItem('vscode-state', JSON.stringify(state));
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.hostMessages.some((item) => item.type === 'ready'))).toBe(true);
  await chat.send({ type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true });
  await expect(page.locator('.queued-input')).toHaveCount(0);
  expect(await chat.received('prompt')).toEqual([]);
});

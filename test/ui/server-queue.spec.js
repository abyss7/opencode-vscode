'use strict';

const { test, expect } = require('./fixture');
const user = (id, text) => ({ id, type: 'user', text, time: { created: 1767268800000 } });
const answer = (text, completed = false) => ({ id: 'msg_answer', type: 'assistant',
  content: [{ type: 'text', text }], time: { created: 1767268801000, ...(completed ? { completed: 1767268802000 } : {}) } });
const transcript = (messages, inbox = [], states = []) => ({ type: 'transcript', messages, inbox, states });

test('queued input streams in order and reconnect does not duplicate DOM or messages', async ({ page, chat }) => {
  await chat.send(transcript([user('msg_first', 'First'), answer('Working')]), { type: 'historyEnd' }, { type: 'status', state: 'busy' });
  await page.locator('#input').fill('Next');
  await page.locator('#input').press('Enter');
  const [input] = await chat.received('prompt');
  expect(input.id).toMatch(/^msg_/);
  const item = { id: input.id, type: 'user', payload: { text: 'Next' }, time: { created: 1767268802000 } };
  await chat.send({ type: 'submission', id: input.id, state: 'queued', item });
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Queued');
  await chat.send({ type: 'transcript', messages: [], partial: true });
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Queued');
  await page.evaluate(() => { window.originalMessage = document.querySelector('.assistant'); });
  await chat.send(transcript([answer('Working live')], [item], [['msg_first', 'running'], [input.id, 'queued']]));
  await expect(page.locator('.assistant .body')).toHaveText('Working live');
  expect(await page.evaluate(() => window.originalMessage === document.querySelector('.assistant'))).toBe(true);
  await chat.send(transcript([answer('Working live', true), user(input.id, 'Next')], [], [['msg_first', 'completed'], [input.id, 'running']]));
  await chat.send(transcript([user('msg_first', 'First'), answer('Working live', true), user(input.id, 'Next')], [], [['msg_first', 'completed'], [input.id, 'completed']]));
  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.locator('.assistant')).toHaveCount(1);
  await expect(page.locator('.queued-input')).toHaveCount(0);
  await expect(page.locator(`.message[data-message-id="${input.id}"] .delivery-status`)).toHaveText('Completed');
});

test('/archive remains a queued command while the session is busy', async ({ page, chat }) => {
  await chat.send(
    { type: 'slashItems', skills: [], commands: [{ name: 'archive', description: 'Archive this session' }] },
    { type: 'status', state: 'busy' }
  );
  await page.locator('#input').fill('/archive');
  await page.locator('#input').press('Enter');
  await page.locator('#input').press('Enter');
  await expect.poll(async () => chat.received('command')).toEqual([
    { type: 'command', name: 'archive', text: '' },
  ]);
  expect(await chat.received('prompt')).toEqual([]);
});

test('archived sessions hide the composer until they are restored', async ({ page, chat }) => {
  await chat.send({ type: 'sessionInfo', title: 'Archived session', archived: true });
  await expect(page.locator('#composer')).toBeHidden();
  await expect(page.locator('#input')).toBeDisabled();
  expect(await chat.received('prompt')).toEqual([]);
  await chat.send({ type: 'sessionInfo', title: 'Restored session', archived: false });
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#input')).toBeEnabled();
});

test('history reconciliation preserves a scrolled viewport and tool disclosure', async ({ page, chat }) => {
  const messages = Array.from({ length: 40 }, (_, i) => user(`msg_${i}`, `Message ${i}\n${'Long message '.repeat(15)}`));
  await chat.send(transcript(messages), { type: 'historyEnd' });
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 350; });
  await expect.poll(() => page.locator('#messages').evaluate((node) => node.scrollTop)).toBe(350);
  await chat.send(transcript([answer('New output at the bottom')]));
  expect(await page.locator('#messages').evaluate((node) => Math.abs(node.scrollTop - 350))).toBeLessThan(3);
});

test('a recreated webview restores its persisted viewport after replay and focus', async ({ page, chat }) => {
  const messages = Array.from({ length: 40 }, (_, i) => user(`msg_restore_${i}`, `Message ${i}\n${'Long message '.repeat(15)}`));
  await chat.send(transcript(messages), { type: 'historyEnd' });
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 450; });
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('vscode-state')).viewport?.top)).toBe(450);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.hostMessages.some((m) => m.type === 'ready'))).toBe(true);
  await chat.send({ type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true },
    transcript(messages), { type: 'historyEnd' }, { type: 'status', state: 'ready' }, { type: 'focus', preserveScroll: true });
  await expect.poll(() => page.locator('#messages').evaluate((node) => Math.abs(node.scrollTop - 450))).toBeLessThan(3);
});

test('a partial snapshot never cancels a queued input', async ({ page, chat }) => {
  await chat.send(transcript([user('msg_first', 'First')]), { type: 'historyEnd' },
    { type: 'submission', id: 'msg_pending', state: 'queued',
      item: { id: 'msg_pending', type: 'user', payload: { text: 'Keep this queued' } } });
  await chat.send({ type: 'transcript', partial: true, messages: [answer('Streaming during reconciliation')] });
  await expect(page.locator('.queued-input')).toHaveAttribute('data-delivery', 'queued');
  await expect(page.locator('.assistant .body')).toContainText('Streaming during reconciliation');
});

test('inbox absence is unconfirmed until delivery or explicit cancellation arrives', async ({ page, chat }) => {
  const item = { id: 'msg_racing', type: 'user', payload: { text: 'Racing delivery' }, time: { created: 1767268802000 } };
  await chat.send(transcript([user('msg_first', 'First')]), { type: 'historyEnd' },
    { type: 'submission', id: item.id, state: 'queued', item }, transcript([]));
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Delivery unconfirmed');
  await chat.send(transcript([{ ...user(item.id, item.payload.text), time: item.time }], [], [[item.id, 'completed']]));
  await expect(page.locator('.queued-input')).toHaveCount(0);
  await expect(page.locator(`[data-message-id="${item.id}"] .delivery-status`)).toHaveText('Completed');
  await expect(page.locator('.message.user')).toHaveCount(2);
  expect(await chat.received('prompt')).toEqual([]);
});

for (const cachedState of ['queued', 'cancelled', 'sending']) {
  test(`restored ${cachedState} input is unconfirmed and stays before the newer turn`, async ({ page, chat }) => {
    const old = { id: 'msg_old', state: cachedState,
      item: { id: 'msg_old', type: 'user', payload: { text: 'Earlier request' }, time: { created: 1767268801000 } } };
    const newer = { ...user('msg_new', 'New request'), time: { created: 1767268802000 } };
    await page.evaluate((submission) => sessionStorage.setItem('vscode-state', JSON.stringify({
      submissions: [submission],
    })), old);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.hostMessages.some((m) => m.type === 'ready'))).toBe(true);
    // The host loads history before posting the session identity on reopening.
    await chat.send(transcript([user('msg_first', 'First'), newer]),
      { type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true }, { type: 'historyEnd' });
    await expect(page.locator('.queued-input .delivery-status')).toHaveText('Delivery unconfirmed');
    await chat.send(transcript([answer('New answer', true)], [], [[newer.id, 'completed']]));
    expect(await page.locator('.message').evaluateAll((nodes) => nodes.map((n) => n.dataset.messageId)))
      .toEqual(['msg_first', old.id, newer.id, 'msg_answer']);
    expect(await chat.received('prompt')).toEqual([]);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('vscode-state')).submissions[0].state)).toBe('unknown');
  });
}

test('explicit cancellation survives reload without following subsequent replies to the bottom', async ({ page, chat }) => {
  const item = { id: 'msg_cancelled', type: 'user', payload: { text: 'Cancelled request' }, time: { created: 1767268801000 } };
  const newer = { ...user('msg_new', 'New request'), time: { created: 1767268802000 } };
  await chat.send(transcript([user('msg_first', 'First')]), { type: 'historyEnd' },
    { type: 'submission', id: item.id, state: 'queued', item },
    { type: 'submission', id: item.id, state: 'cancelled' },
    { type: 'submission', id: 'msg_synthetic', state: 'cancelled' },
    transcript([newer, answer('New answer', true)], [], [[newer.id, 'completed']]));
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Cancelled');
  expect(await page.locator('.message').evaluateAll((nodes) => nodes.map((n) => n.dataset.messageId)))
    .toEqual(['msg_first', item.id, newer.id, 'msg_answer']);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.hostMessages.some((m) => m.type === 'ready'))).toBe(true);
  await chat.send({ type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true },
    transcript([user('msg_first', 'First'), newer, answer('New answer', true)], [], [[newer.id, 'completed']]),
    { type: 'historyEnd' });
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Cancelled');
  expect(await page.locator('.message').evaluateAll((nodes) => nodes.map((n) => n.dataset.messageId)))
    .toEqual(['msg_first', item.id, newer.id, 'msg_answer']);
});

test('a restored cancellation cannot overwrite a freshly confirmed queue entry', async ({ page, chat }) => {
  const item = { id: 'msg_queued', type: 'user', payload: { text: 'Still queued' }, time: { created: 1767268801000 } };
  await page.evaluate((item) => sessionStorage.setItem('vscode-state', JSON.stringify({
    submissions: [{ id: item.id, item, state: 'cancelled' }],
  })), item);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.hostMessages.some((m) => m.type === 'ready'))).toBe(true);
  await chat.send(transcript([user('msg_first', 'First')], [item]),
    { type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true }, { type: 'historyEnd' });
  await expect(page.locator('.queued-input .delivery-status')).toHaveText('Queued');
});

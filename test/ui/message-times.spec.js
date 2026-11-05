'use strict';

const { test, expect } = require('./fixture');

test('history timestamps use local dates, seconds and independent message IDs', async ({ page, chat }) => {
  await chat.send({ type: 'historyReset' });
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'user-old', content: { type: 'text', text: 'An old question.' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'answer-yesterday', content: { type: 'text', text: 'An answer from yesterday.' } });
  await chat.send({ type: 'historyEnd' });
  await expect(page.locator('.message-time')).toHaveCount(0);
  await chat.send({ type: 'messageTimes', times: [
    { id: 'user-old', timestamp: Date.parse('2025-12-20T13:04:05Z') },
    { id: 'answer-yesterday', timestamp: Date.parse('2025-12-31T23:59:58Z') },
  ] });
  await expect(page.locator('.user .message-time')).toHaveText('12/20/2025 01:04:05 PM');
  await expect(page.locator('.assistant .message-time')).toHaveText('yesterday 11:59:58 PM');
  await expect(page.locator('.assistant .message-time')).toHaveAttribute('datetime', '2025-12-31T23:59:58.000Z');
  await chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'answer-today', content: { type: 'text', text: 'A fresh answer.' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.assistant .message-time').last()).toHaveText('today 12:00:00 PM');
  for (const wrap of await page.locator('.message').all()) {
    const box = await wrap.boundingBox();
    const body = await wrap.locator(':scope > .body').boundingBox();
    const time = await wrap.locator('.message-time').boundingBox();
    expect(time.x + time.width).toBeCloseTo(box.x + box.width - 2, 0);
    expect(time.x).toBeGreaterThanOrEqual(body.x + body.width);
    expect(Math.abs(time.y - body.y)).toBeLessThanOrEqual(5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('timestamps arriving before replay are retained and chunk updates keep the original time', async ({ page, chat }) => {
  await chat.send({ type: 'historyReset' });
  await chat.send({ type: 'messageTimes', times: [{ id: 'answer', timestamp: Date.parse('2026-01-01T10:01:02Z') }] });
  await chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'First ' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'second.' } });
  await chat.send({ type: 'historyEnd' });
  await expect(page.locator('.message-time')).toHaveCount(1);
  await expect(page.locator('.message-time')).toHaveText('today 10:01:02 AM');
  await page.clock.setFixedTime(new Date('2026-01-02T00:00:00Z'));
  await expect(page.locator('.message-time')).toHaveText('yesterday 10:01:02 AM');
  await chat.send({ type: 'historyReset' });
  await expect(page.locator('.message-time')).toHaveCount(0);
});

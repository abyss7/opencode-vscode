'use strict';

// A running turn streams its steps raw and folds them only on the outcome.
// Folding collapses thousands of streamed pixels and — for a parked reader —
// the browser would clamp the view upward through the missing space. A
// terminal never collapses its scrollback under the reader: while parked, the
// fold is deferred; it applies as soon as following resumes.

const { test, expect } = require('./fixture');

const filler = (tag, n = 40) => `Unique ${tag} paragraph for the parked reader. `.repeat(n);
const history = Array.from({ length: 4 }, (_, i) => `## Section ${i + 1}\n\n${filler('history-' + (i + 1))}\n\n`).join('');

async function streamTurn(chat) {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'Second prompt' } });
  for (let i = 1; i <= 30; i++) {
    await chat.update({ sessionUpdate: 'thought_message_chunk', content: { type: 'text', text: `Мысль ${i}. ` + 'Рассуждение о создании аккаунта и VPN. '.repeat(300) } });
    await chat.update({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, kind: 'read', title: `Read file ${i}`, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Result line '.repeat(60) } }] });
  }
}

test('a parked reader defers the fold; returning to the bottom applies it', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: history } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await streamTurn(chat);
  await page.waitForTimeout(150);

  const parked = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    const anchor = [...m.querySelectorAll('.md p')].at(-2);
    anchor.dataset.testAnchor = 'parked';
    m.scrollTop += anchor.getBoundingClientRect().top - m.getBoundingClientRect().top - 60;
    m.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
    return { top: Math.round(m.scrollTop), anchorTop: Math.round(anchor.getBoundingClientRect().top) };
  });
  // The turn completes: the answer arrives and the steps would fold.
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Финальный ответ на второй ход. ' + filler('final') } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.waitForTimeout(250);

  const parkedStill = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    const anchor = m.querySelector('[data-test-anchor="parked"]');
    return { top: Math.round(m.scrollTop), anchorTop: Math.round(anchor.getBoundingClientRect().top),
      liveOpen: [...m.querySelectorAll('.turn-steps')].some((n) => n.open) };
  });
  expect(parkedStill.top, 'the parked reader does not move').toBe(parked.top);
  expect(Math.abs(parkedStill.anchorTop - parked.anchorTop)).toBeLessThanOrEqual(2);

  // Following resumes: any deferred folds apply and the tail is compact.
  await page.evaluate(() => {
    const m = document.querySelector('#messages');
    m.scrollTop = m.scrollHeight - m.clientHeight;
    m.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  const folded = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    return { open: [...m.querySelectorAll('.turn-steps')].filter((n) => n.open).length,
      top: Math.round(m.scrollTop), max: Math.round(m.scrollHeight - m.clientHeight) };
  });
  expect(folded.open).toBe(0);
  expect(folded.top).toBe(folded.max);
});

test('a following reader still sees steps fold immediately', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await streamTurn(chat);
  await page.waitForTimeout(100);
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Финальный ответ. ' + filler('final') } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.waitForTimeout(250);
  const folded = await page.evaluate(() => ({
    open: [...document.querySelectorAll('.turn-steps')].filter((n) => n.open).length,
    gap: (() => { const m = document.querySelector('#messages'); return m.scrollHeight - m.clientHeight - m.scrollTop; })(),
  }));
  expect(folded.open).toBe(0);
  expect(folded.gap).toBeLessThanOrEqual(1);
});

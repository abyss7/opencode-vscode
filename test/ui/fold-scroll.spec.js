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

test('a reader parked inside streamed steps never has those steps collapsed in their face', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await streamTurn(chat);
  await page.waitForTimeout(100);

  // Park directly on tool step #12 inside the live `.turn-steps` container.
  const parked = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    const summary = document.querySelectorAll('.tool-group > summary')[11];
    summary.dataset.testStepAnchor = '1';
    m.scrollTop += summary.getBoundingClientRect().top - m.getBoundingClientRect().top - 80;
    m.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
    return { top: Math.round(m.scrollTop), y: Math.round(summary.getBoundingClientRect().top) };
  });

  // Even when a massive final answer arrives below (keeping total scrollHeight huge),
  // `.turn-steps` must NOT collapse while the reader is anchored inside it.
  const tallAnswer = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: ${filler('tall', 10)}`).join('\n\n');
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tallAnswer } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.waitForTimeout(200);

  const duringRead = await page.evaluate(() => {
    const summary = document.querySelector('[data-test-step-anchor="1"]');
    const block = summary.closest('.turn-steps');
    return {
      open: block.open,
      y: Math.round(summary.getBoundingClientRect().top),
    };
  });
  expect(duringRead.open, 'steps stay open while reader is inside them').toBe(true);
  expect(Math.abs(duringRead.y - parked.y)).toBeLessThanOrEqual(2);

  // Returning to the bottom applies the deferred fold cleanly.
  await page.evaluate(() => {
    const m = document.querySelector('#messages');
    m.scrollTop = m.scrollHeight - m.clientHeight;
    m.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  expect(await page.locator('.turn-steps[open]').count()).toBe(0);
});

test('native server idle snapshot folds streamed steps immediately while following', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  const tools = Array.from({ length: 15 }, (_, i) => ({
    type: 'tool',
    id: `nt_${i}`,
    name: 'read',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `nt_${i}`,
      title: `Read ${i}`,
      kind: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Line '.repeat(40) } }],
    },
  }));
  await chat.send({
    type: 'transcript',
    partial: true,
    messages: [{ id: 'm_run', type: 'assistant', time: { created: 100 }, content: tools }],
  });
  await expect(page.locator('.turn-steps')).toHaveClass(/live/);
  await expect(page.locator('.turn-steps')).toHaveAttribute('open', '');

  await chat.send({
    type: 'transcript',
    messages: [
      { id: 'm_run', type: 'assistant', time: { created: 100, completed: 200 }, content: tools },
      { id: 'm_idle', type: 'idle', outcome: 'succeeded' },
    ],
    inbox: [],
    states: [],
  });
  await expect(page.locator('.turn-steps')).not.toHaveClass(/live/);
  await expect(page.locator('.turn-steps')).not.toHaveAttribute('open', '');
});

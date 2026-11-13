'use strict';

// The transcript is a terminal: the reader is either pinned to the bottom
// (new output keeps the bottom line at the bottom) or parked on a chunk of
// content that no update may move. Nothing in between.

const { test, expect } = require('./fixture');

const gap = (page) => page.locator('#messages').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
const park = (page, fromBottom = 900) => page.evaluate((offset) => {
  const messages = document.querySelector('#messages');
  messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - offset);
  // A reader's wheel gesture suspends follow-bottom.
  messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
}, fromBottom);
const paragraphTop = (page, marker) => page.evaluate((text) => {
  const paragraphs = [...document.querySelectorAll('#messages .md p, #messages .md pre, #messages .md tr')];
  const node = paragraphs.find((item) => item.textContent.trim().startsWith(text));
  return node ? Math.round(node.getBoundingClientRect().top) : null;
}, marker);

const message = (id, text, completed) => ({ id, type: 'assistant',
  time: { created: 1767268800000, ...(completed ? { completed: 1767268801000 } : {}) },
  content: [{ type: 'text', text }] });
const longAnswer = (sections) => Array.from({ length: sections }, (_, i) =>
  `## Section ${i + 1}\n\nParagraph ${i + 1} marker ${i + 1}. ${'Tall filler sentence so the answer exceeds the viewport. '.repeat(40)}\n\n`).join('');

const tool = (chat, id) => chat.update({ sessionUpdate: 'tool_call', toolCallId: id,
  title: 'shell', kind: 'execute', status: 'completed', rawInput: { command: `echo ${id}`, background: true },
  background: { id: `sh_${id}`, toolCallId: id, status: 'unknown' },
  content: [{ type: 'content', content: { type: 'text', text: `Result ${id}` } }] });
const background = (chat, output) => chat.send({ type: 'background', runs: [
  { id: 'sh_bg', toolCallId: 'bg', status: 'running', output }] });

test('pinned to the bottom, every kind of output keeps the bottom line at the bottom', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'bg');
  await background(chat, 'first line\n');
  await chat.send({ type: 'transcript', messages: [message('m1', longAnswer(4), false)] });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  // Streaming continuation, a rerender, completion with its outline, background
  // posts and idle metadata must all leave the view glued to the newest line.
  const steps = [
    ['stream grows below', () => chat.send({ type: 'transcript', messages: [message('m1', longAnswer(4) + 'Latest tail line.\n\n', false)] })],
    ['answer completes with outline', () => chat.send({ type: 'transcript', messages: [message('m1', longAnswer(4) + 'Latest tail line.\n\n', true)] })],
    ['background card updates', () => background(chat, 'first line\nsecond line\nthird line\n')],
    ['idle metadata', () => chat.send({ type: 'messageTimes', times: [{ id: 'm1', timestamp: 1767268900000 }] })],
    ['subagent strip', () => chat.send({ type: 'subagents', items: [{ id: 'ses_child', title: 'Worker', running: true }] })],
  ];
  for (const [name, step] of steps) {
    await step();
    await page.waitForTimeout(80);
    expect(await gap(page)).toBeLessThanOrEqual(1);
    const lastVisible = await page.evaluate(() => {
      const messages = document.querySelector('#messages');
      const box = messages.getBoundingClientRect();
      const last = [...messages.querySelectorAll('p, pre, summary, time, .tool-group')].at(-1)?.getBoundingClientRect();
      // Pinned to the bottom, the newest line must be the last thing on screen:
      // fully inside the viewport, with only the transcript's trailing space below.
      return Boolean(last && last.height > 0 && last.bottom <= box.bottom + 1 &&
        last.bottom >= box.top && box.bottom - last.bottom < 48);
    });
    expect(lastVisible, `${name}: the newest line stays on screen`).toBe(true);
  }
});

test('parked on a chunk, the same updates leave the viewed pixels untouched', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'bg');
  await background(chat, 'first line\n');
  await chat.send({ type: 'transcript', messages: [message('m1', longAnswer(6), true)] });
  await park(page, 1500);
  const baseline = await paragraphTop(page, 'Paragraph 4 marker 4');
  expect(baseline).not.toBeNull();
  const steps = [
    ['stream grows below', () => chat.send({ type: 'transcript', messages: [
      message('m1', longAnswer(6), true), message('m2', longAnswer(2) + 'Growing tail.\n\n', false)] })],
    ['answer completes with outline', () => chat.send({ type: 'transcript', messages: [
      message('m1', longAnswer(6), true), message('m2', longAnswer(2) + 'Growing tail.\n\n', true)] })],
    ['background card updates above', () => background(chat, 'first line\nsecond line\nthird line\nfourth line\n')],
    ['idle metadata', () => chat.send({ type: 'messageTimes', times: [{ id: 'm1', timestamp: 1767268900000 }] })],
    ['full rerender of the same content', () => chat.send({ type: 'transcript', messages: [
      message('m1', longAnswer(6), true), message('m2', longAnswer(2) + 'Growing tail.\n\n', true)] })],
  ];
  for (const [name, step] of steps) {
    await step();
    await page.waitForTimeout(80);
    const top = await paragraphTop(page, 'Paragraph 4 marker 4');
    expect(Math.abs(top - baseline), `${name} must not move the viewed paragraph`).toBeLessThanOrEqual(1);
  }
});

test('wheel up freezes the chunk and wheel back down re-engages the bottom', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.send({ type: 'transcript', messages: [message('m1', longAnswer(6), false)] });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  // Wheel up: the current content freezes even while streaming continues.
  await page.evaluate(() => {
    const messages = document.querySelector('#messages');
    messages.scrollTop -= 600;
    messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  });
  const frozen = await page.evaluate(() => document.querySelector('#messages').scrollTop);
  await chat.send({ type: 'transcript', messages: [message('m1', longAnswer(6) + 'More streamed text.\n\n'.repeat(10), false)] });
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => document.querySelector('#messages').scrollTop)).toBe(frozen);
  // Wheel down onto the bottom line: following resumes and holds.
  await page.evaluate(() => {
    const messages = document.querySelector('#messages');
    messages.scrollTop = messages.scrollHeight - messages.clientHeight;
    messages.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  await chat.send({ type: 'transcript', messages: [message('m1', longAnswer(6) + 'More streamed text.\n\n'.repeat(10) + 'Final line.\n\n', true)] });
  await page.waitForTimeout(120);
  expect(await gap(page)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.querySelector('#messages').textContent)).toContain('Final line.');
});

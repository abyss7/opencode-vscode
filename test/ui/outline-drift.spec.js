'use strict';

const { test, expect } = require('./fixture');

const sections = (count) => Array.from({ length: count }, (_, i) =>
  `## Section ${i + 1}\n\n${'Readable paragraph text for measuring. '.repeat(30)}\n\n`).join('');
const message = (id, text, completed) => ({ id, type: 'assistant',
  time: { created: 1, ...(completed ? { completed: 2 } : {}) },
  content: [{ type: 'text', text }] });
const parkOn = (page, index) => page.evaluate((position) => {
  const messages = document.querySelector('#messages');
  const heading = [...messages.querySelectorAll('h2')][position];
  messages.scrollTop += heading.getBoundingClientRect().top - messages.getBoundingClientRect().top - 60;
  // A reader's wheel gesture suspends follow-bottom and anchors the viewport.
  messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
  return Math.round(heading.getBoundingClientRect().top);
}, index);

// Completing an answer prepends its "On this page" outline above the reader.
// The recorded anchor path must not slide onto the neighbouring node, or the
// viewport drifts up toward the top of the answer.
test('outline prepended at completion keeps a parked mid-answer reader in place', async ({ page, chat }) => {
  await chat.send({ type: 'transcript', messages: [message('m1', sections(6), false)] });
  const parkedHeadingTop = await parkOn(page, 2);
  await chat.send({ type: 'transcript', messages: [message('m1', sections(6), true)] });
  await expect(page.locator('.answer-outline summary')).toHaveText('On this page (6)');
  // Later snapshots re-render the same answer; the anchor must stay put.
  for (let i = 0; i < 3; i++) {
    await chat.send({ type: 'transcript', messages: [message('m1', sections(6), true)] });
    await page.waitForTimeout(60);
  }
  const headingTop = await page.evaluate(() =>
    Math.round([...document.querySelector('#messages').querySelectorAll('h2')][2].getBoundingClientRect().top));
  expect(Math.abs(headingTop - parkedHeadingTop)).toBeLessThan(2);
});

test('streaming growth below a parked reader never moves their paragraph', async ({ page, chat }) => {
  await chat.send({ type: 'transcript', messages: [message('m1', sections(6), true)] });
  await expect(page.locator('.answer-outline summary')).toHaveText('On this page (6)');
  const parkedHeadingTop = await parkOn(page, 2);
  for (let i = 1; i <= 4; i++) {
    await chat.send({ type: 'transcript', messages: [
      message('m1', sections(6), true),
      message('m2', sections(3) + `Tail ${i}\n\n${'more text '.repeat(40 * i)}`, false),
    ] });
    await page.waitForTimeout(60);
  }
  const headingTop = await page.evaluate(() =>
    Math.round([...document.querySelector('#messages').querySelectorAll('h2')][2].getBoundingClientRect().top));
  expect(Math.abs(headingTop - parkedHeadingTop)).toBeLessThan(2);
});

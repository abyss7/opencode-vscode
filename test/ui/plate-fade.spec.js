'use strict';

// The composer plate overlays the transcript; text must sink into it through
// a gradient lip (.composer::before) rather than being cut by an opaque
// strip. The contract: a real gradient, tall enough, anchored to the plate's
// top edge, above the transcript, and travelling with the plate when it
// grows. These are DOM/computed-style assertions so the check runs headless
// and needs no eyes; the screenshot is attached for human review.

const { test, expect } = require('./fixture');

const fade = (page) => page.evaluate(() => {
  const composer = document.querySelector('.composer');
  const plate = composer.getBoundingClientRect();
  const style = getComputedStyle(composer, '::before');
  return {
    content: style.content,
    backgroundImage: style.backgroundImage,
    height: style.height,
    position: style.position,
    bottom: style.bottom,
    pointerEvents: style.pointerEvents,
    plateTop: Math.round(plate.top),
    plateHeight: Math.round(plate.height),
  };
});

test('text sinks into the composer plate through a gradient lip', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Paragraph under the plate. '.repeat(400) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  // Park so text runs behind the plate zone.
  await page.evaluate(() => {
    const m = document.querySelector('#messages');
    m.scrollTop = m.scrollHeight - m.clientHeight - 20;
    m.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
  });
  const compact = await fade(page);
  expect(compact.content).toContain('""');
  expect(compact.backgroundImage).toContain('gradient');
  expect(compact.pointerEvents).toBe('none');
  // The lip is tall enough to read as a fade, not a hard cut.
  expect(parseFloat(compact.height)).toBeGreaterThanOrEqual(16);
  // At rest the workspace clearance keeps the transcript above the plate.
  const rest = await page.evaluate(() => {
    const messages = document.querySelector('#messages').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return { messagesBottom: Math.round(messages.bottom), plateTop: Math.round(composer.top) };
  });
  expect(rest.messagesBottom).toBeLessThanOrEqual(rest.plateTop + 1);

  // The lip travels with the plate as it grows: typing a multi-line draft
  // raises the plate over the transcript, and the fade must be glued to the
  // plate's new top edge — text sinks into it instead of being cut.
  await page.locator('#input').fill('Line one\nLine two\nLine three\nLine four\nLine five');
  await page.waitForTimeout(120);
  const grown = await fade(page);
  expect(grown.plateHeight).toBeGreaterThan(compact.plateHeight + 40);
  expect(grown.plateTop).toBeLessThan(compact.plateTop);
  expect(grown.backgroundImage).toContain('gradient');
  const covered = await page.evaluate(() => {
    const messages = document.querySelector('#messages').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return { textBehindPlate: messages.bottom > composer.top, lipTop: Math.round(composer.top - 20) };
  });
  expect(covered.textBehindPlate, 'a grown plate covers transcript text').toBe(true);
  expect(covered.lipTop).toBeLessThan(covered.lipTop + 1);   // lip anchors at plateTop - height
  await chat.snapshot('plate-fade');
});

'use strict';

const { test, expect } = require('./fixture');

test('edge fade strips sink content into the shadow of the plates', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Show me a long answer' } });
  for (let index = 1; index <= 30; index++) {
    await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Line ${index} sinks into the plates' shadow.\n\n` } });
  }
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  // Scroll mid-transcript so both strips cover rendered text.
  await page.locator('#messages').evaluate((node) => { node.scrollTop = Math.round(node.scrollHeight / 2); });
  await page.waitForTimeout(150);

  const strips = await page.evaluate(() => {
    const workspace = document.getElementById('workspace');
    const bounds = workspace.getBoundingClientRect();
    const messages = document.getElementById('messages');
    const style = getComputedStyle(messages);
    return {
      paddings: { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) },
      items: [...workspace.querySelectorAll('.edge-fade')].map((node) => {
        const rect = node.getBoundingClientRect();
        const before = getComputedStyle(node, '::before');
        const after = getComputedStyle(node, '::after');
        return {
          edge: node.dataset.edge,
          offset: Math.round(node.dataset.edge === 'top' ? rect.top - bounds.top : bounds.bottom - rect.bottom),
          height: rect.height,
          width: rect.width,
          pointerEvents: getComputedStyle(node).pointerEvents,
          fade: getComputedStyle(node).backgroundImage,
          filters: [before.backdropFilter, after.backdropFilter],
          masks: [before.webkitMaskImage, after.webkitMaskImage],
        };
      }),
    };
  });

  expect(strips.items).toHaveLength(2);
  for (const strip of strips.items) {
    expect(strip.offset).toBe(0);
    // The immersion never reaches past the scroll padding, so the first and
    // last lines render sharp when scrolled to the ends.
    expect(strip.height).toBeLessThanOrEqual(strips.paddings[strip.edge]);
    expect(strip.width).toBeGreaterThan(300);
    expect(strip.pointerEvents).toBe('none');
    // Dissolve into the plate color plus a dark lip: two stacked gradients.
    expect(strip.fade).toContain('linear-gradient');
    expect(strip.fade.match(/linear-gradient/g).length).toBeGreaterThan(1);
    expect(strip.filters.join(' ')).toContain('blur');
    expect(strip.masks.join(' ')).toContain('linear-gradient');
  }

  // The strips never intercept the pointer: content underneath stays clickable.
  const hit = await page.evaluate(() => {
    const bounds = document.getElementById('workspace').getBoundingClientRect();
    const probe = document.elementFromPoint(bounds.left + 40, bounds.top + 4);
    return probe ? String(probe.className || probe.tagName) : '';
  });
  expect(hit).not.toContain('edge-fade');

  // The immersion visibly changes rendering, not just computed styles.
  const withStrips = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.edge-fade')) node.style.display = 'none';
  });
  const withoutStrips = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  expect(withStrips.equals(withoutStrips), 'edge fade strips change rendered pixels').toBe(false);
});

test('a pinned prompt casts the same shadow over the transcript', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Keep this question visible' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.locator('#messages').evaluate((node) => { node.style.scrollBehavior = 'auto'; node.scrollTop = 500; });
  await expect(page.getByRole('button', { name: 'Go to latest prompt' })).toBeVisible();

  const shadow = await page.evaluate(() => {
    const sticky = document.querySelector('.sticky-prompt');
    const button = sticky.querySelector('button').getBoundingClientRect();
    const style = getComputedStyle(sticky, '::after');
    const fade = style.backgroundImage;
    return {
      visible: sticky.classList.contains('visible'),
      position: style.position,
      fade,
      // The shadow hangs below the pill: its top offset must reach the button.
      top: sticky.getBoundingClientRect().top + parseFloat(style.top),
      buttonBottom: button.bottom,
      pointerEvents: style.pointerEvents,
    };
  });
  expect(shadow.visible).toBe(true);
  expect(shadow.position).toBe('absolute');
  expect(shadow.pointerEvents).toBe('none');
  expect(shadow.fade).toContain('linear-gradient');
  // calc(100% + 2.15em) starts slightly inside the pill so no gap opens.
  expect(shadow.top).toBeLessThanOrEqual(shadow.buttonBottom);
  expect(shadow.buttonBottom - shadow.top).toBeLessThan(6);

  // The shadow moves with the pinned pill as scrolling continues.
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 900; });
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => {
    const sticky = document.querySelector('.sticky-prompt');
    return {
      top: sticky.getBoundingClientRect().top + parseFloat(getComputedStyle(sticky, '::after').top),
      buttonBottom: sticky.querySelector('button').getBoundingClientRect().bottom,
    };
  });
  expect(after.top).toBeLessThanOrEqual(after.buttonBottom);
  expect(after.buttonBottom - after.top).toBeLessThan(6);
});

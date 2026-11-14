'use strict';

const { test, expect } = require('./fixture');

test('edge fade strips blur content sliding under the header and composer', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Show me a long answer' } });
  for (let index = 1; index <= 30; index++) {
    await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Line ${index} dissolves at the plate edges.\n\n` } });
  }
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  // Scroll mid-transcript so both strips cover rendered text.
  await page.locator('#messages').evaluate((node) => { node.scrollTop = Math.round(node.scrollHeight / 2); });
  await page.waitForTimeout(150);

  const strips = await page.evaluate(() => {
    const workspace = document.getElementById('workspace');
    const bounds = workspace.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(document.getElementById('messages')).paddingTop);
    return {
      padding,
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
          filters: [before.backdropFilter, after.backdropFilter],
          masks: [before.webkitMaskImage, after.webkitMaskImage],
        };
      }),
    };
  });

  expect(strips.items).toHaveLength(2);
  for (const strip of strips.items) {
    expect(strip.offset).toBe(0);
    expect(strip.height).toBeLessThan(strips.padding);
    expect(strip.width).toBeGreaterThan(300);
    expect(strip.pointerEvents).toBe('none');
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

  // The blurred strips visibly change rendering, not just computed styles.
  const withStrips = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.edge-fade')) node.style.display = 'none';
  });
  const withoutStrips = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  expect(withStrips.equals(withoutStrips), 'edge fade strips change rendered pixels').toBe(false);
});

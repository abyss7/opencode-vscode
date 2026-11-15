'use strict';

const { test, expect } = require('./fixture');
const fourLines = 'First line\nSecond line\nThird line\nFourth line';

async function attachImage(page) {
  await page.locator('#input').evaluate(node => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], 'context.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#attachments img')).toBeVisible();
}

async function prepare(page, chat) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: {
    type: 'text', text: Array.from({ length: 160 }, (_, i) => `Reading paragraph ${i}. Text that must stay in place.`).join('\n\n'),
  } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' },
    { type: 'config', configOptions: [
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
      { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: ['low', 'high'].map(value => ({ value, name: value })) },
    ] });
  await expect.poll(() => page.locator('#messages').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
}

async function watchReading(page) {
  await page.evaluate(() => {
    const messages = document.querySelector('#messages');
    const box = messages.getBoundingClientRect();
    const anchor = [...messages.querySelectorAll('p')].find(node => node.getBoundingClientRect().top >= box.top + 16);
    const initial = { top: messages.scrollTop, height: messages.clientHeight, content: messages.scrollHeight, y: anchor.getBoundingClientRect().top };
    const watch = window.__overlayWatch = { frames: 0, scroll: 0, anchor: 0, geometry: 0, outer: 0 };
    function sample() {
      watch.scroll = Math.max(watch.scroll, Math.abs(messages.scrollTop - initial.top));
      watch.anchor = Math.max(watch.anchor, Math.abs(anchor.getBoundingClientRect().top - initial.y));
      const bounds = messages.getBoundingClientRect();
      watch.geometry = Math.max(watch.geometry, Math.abs(messages.clientHeight - initial.height),
        Math.abs(messages.scrollHeight - initial.content), Math.abs(bounds.top - box.top), Math.abs(bounds.bottom - box.bottom));
      for (const node of [document.documentElement, document.body, ...document.querySelectorAll('#app, #workspace, #composer, #composer-controls')]) {
        watch.outer = Math.max(watch.outer, Math.abs(node.scrollTop), Math.abs(node.scrollLeft));
      }
    }
    function frame() { sample(); watch.frames++; requestAnimationFrame(frame); }
    document.addEventListener('scroll', sample, true);
    frame();
  });
  return async () => {
    const frames = await page.evaluate(() => window.__overlayWatch.frames);
    await expect.poll(() => page.evaluate(() => window.__overlayWatch.frames)).toBeGreaterThan(frames + 3);
    const watch = await page.evaluate(() => window.__overlayWatch);
    expect(watch.geometry, 'composer edits never resize the transcript or its scroll range').toBe(0);
    expect(watch.scroll, 'transcript does not scroll, including while following').toBeLessThanOrEqual(1);
    expect(watch.anchor, 'no transient paragraph movement').toBeLessThanOrEqual(1);
    expect(watch.outer, 'no ancestor or composer panel scrolls').toBe(0);
  };
}

for (const reading of ['following', 'parked-near-bottom', 'parked-middle']) {
  test(`overlay growth and shrink preserve geometry and every painted pixel (${reading})`, async ({ page, chat }) => {
    await prepare(page, chat);
    const messages = page.locator('#messages');
    if (reading !== 'following') {
      const distance = reading === 'parked-near-bottom' ? 20 : 700;
      await messages.hover();
      await page.mouse.wheel(0, -distance);
      await expect.poll(() => messages.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeCloseTo(distance, 0);
    }
    const stable = await watchReading(page);
    const input = page.locator('#input');
    await attachImage(page);
    await stable();
    await input.fill(fourLines);
    await stable();
    await input.fill('Long draft line\n'.repeat(60));
    await stable();
    await input.hover();
    for (const direction of [-1, 1]) {
      await page.mouse.wheel(0, direction * 10000);
      await expect.poll(() => input.evaluate((node, direction) => direction > 0
        ? node.scrollHeight - node.clientHeight - node.scrollTop : node.scrollTop, direction)).toBeLessThan(2);
      await page.mouse.wheel(0, direction * 400);
      await stable();
    }
    await input.fill(fourLines);
    await stable();
    await input.fill('Short draft');
    await stable();
    await page.getByRole('button', { name: 'Remove image', exact: true }).click();
    await input.fill('');
    await stable();
    if (reading === 'following') {
      await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Next streamed output.\n\n'.repeat(20) } });
      await expect.poll(() => messages.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    }
  });
}

for (const height of [900, 450]) {
  test(`one image and four lines fit; long drafts use available overlay space (${height}px)`, async ({ page, chat }, testInfo) => {
    await page.setViewportSize({ ...page.viewportSize(), height });
    await prepare(page, chat);
    const input = page.locator('#input');
    await attachImage(page);
    for (const draft of ['four-lines', 'long', 'four-lines-again']) {
      await input.fill(draft === 'long' ? 'Long draft line\n'.repeat(60) : fourLines);
      const layout = await page.evaluate(() => {
        const composer = document.querySelector('#composer');
        const controls = document.querySelector('#composer-controls');
        const bounds = controls.getBoundingClientRect();
        const input = document.querySelector('#input');
        return {
          height: composer.getBoundingClientRect().height,
          top: composer.getBoundingClientRect().top,
          controlsOverflow: controls.scrollHeight - controls.clientHeight,
          textOverflow: input.scrollHeight - input.clientHeight,
          controlsScroll: getComputedStyle(controls).overflowY,
          visible: ['#attachments', '#input', '#config-bar', '#send', '.usage-bar'].every(selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
          }),
        };
      });
      await testInfo.attach(`layout-${draft}`, { body: JSON.stringify(layout), contentType: 'application/json' });
      console.log(`${testInfo.project.name} ${height}px ${draft}: ${JSON.stringify(layout)}`);
      await chat.snapshot(`overlay-${draft}`);
      expect.soft(layout.top, 'the original workspace reachability guard remains').toBeGreaterThanOrEqual(150 - 1);
      if (height === 900 && draft === 'long') {
        expect.soft(layout.height, 'a tall window allows growth beyond the rejected fixed cap').toBeGreaterThan(320);
      }
      expect.soft(layout.controlsOverflow, 'the outer composer has no scrollable overflow').toBeLessThanOrEqual(1);
      expect.soft(layout.controlsScroll, 'controls never become a second scrollport').toBe('visible');
      expect.soft(layout.visible, 'attachments, full textarea, metadata and buttons are all visible').toBe(true);
      if (draft !== 'long') expect.soft(layout.textOverflow, 'four lines need no textarea scrollbar').toBeLessThanOrEqual(1);
      else expect.soft(layout.textOverflow, 'only excess text scrolls').toBeGreaterThan(0);
    }
    await input.fill('');
    await page.getByRole('button', { name: 'Remove image', exact: true }).click();
    expect(await input.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
  });
}

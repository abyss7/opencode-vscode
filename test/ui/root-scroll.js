'use strict';

const { expect } = require('./fixture');

async function watchRootScroll(page, footer = '#composer', { forceOverflow = true } = {}) {
  if (forceOverflow) await page.evaluate(() => {
    window.__testRootOverflow = true;
    // Deliberately bypass root containment to test each navigation handler on
    // its own. Production containment has separate keyboard/layout tests.
    document.documentElement.style.overflow = 'visible';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'static';
    // Native root scroll range, without changing the app layout or scroll APIs.
    const tail = document.createElement('div');
    tail.setAttribute('aria-hidden', 'true');
    tail.style.position = 'absolute';
    tail.style.top = '100vh';
    tail.style.height = '300px';
    tail.style.width = '1px';
    document.body.append(tail);
  });
  if (forceOverflow) expect(await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight)).toBe(300);
  const initial = await page.locator(footer).boundingBox();
  await page.evaluate(() => {
    // Start before the action: sampling only afterwards misses transient jumps.
    const watch = window.__rootScrollWatch = { maximum: 0 };
    function sample() {
      watch.maximum = Math.max(watch.maximum, Math.abs(scrollY), Math.abs(scrollX),
        Math.abs(document.body.scrollTop), Math.abs(document.body.scrollLeft));
      requestAnimationFrame(sample);
    }
    sample();
  });
  return async () => {
    const maximum = await page.evaluate(() => new Promise((resolve) => {
      let last = '';
      let stable = 0;
      function sample() {
        const watch = window.__rootScrollWatch;
        watch.maximum = Math.max(watch.maximum, Math.abs(scrollY), Math.abs(scrollX),
          Math.abs(document.body.scrollTop), Math.abs(document.body.scrollLeft));
        const positions = [scrollX, scrollY, ...Array.from(document.querySelectorAll(
          '#input, #messages, #questions, .model-picker-list, #sessions-scroll'
        ), node => node.scrollTop)].join(',');
        stable = positions === last ? stable + 1 : 0;
        last = positions;
        if (stable >= 4) resolve(watch.maximum);
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }));
    expect(maximum, 'navigation must not scroll the root document').toBe(0);
    expect((await page.locator(footer).boundingBox()).y).toBeCloseTo(initial.y, 0);
  };
}

async function scrollTranscript(page, end = true) {
  await page.locator('#messages').evaluate((node, end) => {
    node.style.scrollBehavior = 'auto';
    node.scrollTop = end ? node.scrollHeight : 0;
  }, end);
}

async function expectInside(target, container) {
  const box = await target.boundingBox();
  const viewport = await container.boundingBox();
  expect(box.y + box.height).toBeGreaterThan(viewport.y);
  expect(box.y).toBeLessThan(viewport.y + viewport.height);
}

module.exports = { watchRootScroll, scrollTranscript, expectInside };

'use strict';

const { expect } = require('./fixture');

async function watchRootScroll(page, footer = '#composer') {
  await page.evaluate(() => {
    // Native root scroll range, without changing the app layout or scroll APIs.
    const tail = document.createElement('div');
    tail.setAttribute('aria-hidden', 'true');
    tail.style.position = 'absolute';
    tail.style.top = '100vh';
    tail.style.height = '300px';
    tail.style.width = '1px';
    document.body.append(tail);
  });
  expect(await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight)).toBe(300);
  const initial = await page.locator(footer).boundingBox();
  return async () => {
    const maximum = await page.evaluate(() => new Promise((resolve) => {
      let last = '';
      let stable = 0;
      let maximum = 0;
      function sample() {
        maximum = Math.max(maximum, Math.abs(scrollY), Math.abs(scrollX));
        const positions = [scrollX, scrollY, ...Array.from(document.querySelectorAll(
          '#messages, #questions, .model-picker-list, #sessions-scroll'
        ), node => node.scrollTop)].join(',');
        stable = positions === last ? stable + 1 : 0;
        last = positions;
        if (stable >= 4) resolve(maximum);
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

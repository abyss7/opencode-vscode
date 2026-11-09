'use strict';

const { test, expect } = require('./fixture');
const { watchRootScroll } = require('./root-scroll');

async function overflowOutsideApp(page, kind) {
  if (kind === 'none') return;
  await page.evaluate((kind) => {
    const tail = document.createElement('div');
    tail.id = 'overflow-tail';
    tail.setAttribute('aria-hidden', 'true');
    tail.style.cssText = 'height:300px;width:calc(100vw + 300px)';
    if (kind === 'absolute') tail.style.cssText += ';position:absolute;top:100%;left:0';
    document.body.append(tail);
  }, kind);
}

async function prepare(page, chat, kind) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await overflowOutsideApp(page, kind);
}

for (const overflow of ['none', 'flow', 'absolute']) {
  for (const draft of ['empty', 'short', 'multiline']) {
    test(`composer paging stays local (${draft}, ${overflow} overflow)`, async ({ page, chat }) => {
      await prepare(page, chat, overflow);
      const input = page.locator('#input');
      await input.fill(draft === 'empty' ? '' : draft === 'short' ? 'Draft' : 'Draft line\n'.repeat(80));
      await input.press('Control+Home');
      await page.locator('#messages').evaluate(node => { node.style.scrollBehavior = 'auto'; node.scrollTop = 120; });
      const readingTop = await page.locator('#messages').evaluate(node => node.scrollTop);
      const composer = await page.locator('#composer').boundingBox();
      const stable = await watchRootScroll(page, '#header', { forceOverflow: false });

      for (const key of ['PageDown', 'Shift+PageDown', 'Control+End', 'PageDown', 'ArrowDown',
        'PageUp', 'Shift+PageUp', 'Control+Home', 'PageUp', 'ArrowUp']) {
        await input.press(key);
        await stable();
        await expect(input).toBeFocused();
        expect(await page.locator('#messages').evaluate(node => node.scrollTop)).toBe(readingTop);
        expect((await page.locator('#composer').boundingBox()).y).toBeCloseTo(composer.y, 0);
        if (draft === 'multiline' && key === 'PageDown') {
          expect(await input.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        }
        if (draft === 'multiline' && key.startsWith('Shift+')) {
          expect(await input.evaluate(node => node.selectionEnd - node.selectionStart)).toBeGreaterThan(0);
        }
      }
    });
  }

  test(`document containment blocks ancestor scrolling (${overflow} overflow)`, async ({ page, chat }) => {
    await prepare(page, chat, overflow);
    const stable = await watchRootScroll(page, '#composer', { forceOverflow: false });
    // Test the actual layout contract independently of individual event handlers.
    await page.evaluate(() => {
      window.scrollTo(250, 250);
      document.body.scrollTo(250, 250);
      document.querySelector('#overflow-tail')?.scrollIntoView({ block: 'end' });
    });
    await stable();
    expect(await page.evaluate(() => ({ width: document.scrollingElement.scrollWidth,
      height: document.scrollingElement.scrollHeight }))).toEqual(page.viewportSize());

    const messages = page.locator('#messages');
    await messages.evaluate(node => { node.style.scrollBehavior = 'auto'; node.scrollTop = 0; });
    await messages.hover();
    await page.mouse.wheel(0, 350);
    await expect.poll(() => messages.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await stable();
    await messages.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.mouse.wheel(0, 1200);
    await stable();
    await page.locator('#input').hover();
    await page.mouse.wheel(0, 1200);
    await stable();
  });
}

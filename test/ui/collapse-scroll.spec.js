'use strict';

const { test, expect } = require('./fixture');

for (const { history, rootOverflow } of [
  { history: false, rootOverflow: false },
  { history: true, rootOverflow: false },
  { history: true, rootOverflow: true },
]) {
  test(`collapsing the latest turn keeps the composer fixed (${history ? 'long' : 'empty'} history${rootOverflow ? ', scrollable document' : ''})`, async ({ page, chat }) => {
    if (history) {
      await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'previous', content: { type: 'text', text: 'Previous question' } });
      await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Previous answer.\n\n'.repeat(100) } });
      await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
    }
    await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'latest', content: { type: 'text', text: 'Latest question' } });
    await chat.send(...Array.from({ length: 45 }, (_, index) => ({
      type: 'update',
      update: { sessionUpdate: 'tool_call', toolCallId: `tool-${index}`, title: `Read file ${index}`, kind: 'read', status: 'completed' },
    })));
    await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
    if (rootOverflow) {
      // Model a document with overflow outside the app. overflow:hidden hides its
      // scrollbar but still lets scrollIntoView scroll this ancestor. With no root
      // scroll range, even the broken handler cannot move the composer.
      await page.evaluate(() => {
        window.__testRootOverflow = true;
        document.documentElement.style.overflow = 'visible';
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'static';
        const overflow = document.createElement('div');
        overflow.setAttribute('aria-hidden', 'true');
        overflow.style.height = '300px';
        document.body.append(overflow);
      });
      expect(await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight)).toBe(300);
    }
    await page.locator('#messages').evaluate((node) => { node.style.scrollBehavior = 'auto'; node.scrollTop = node.scrollHeight; });
    const composer = page.locator('.composer');
    const initial = await composer.boundingBox();
    const details = page.locator('details.turn-steps').last();
    const summary = details.locator(':scope > summary');

    for (let attempt = 0; attempt < 2; attempt++) {
      await summary.click();
      const collapse = details.locator(':scope > .disclosure-collapse');
      await expect(collapse).toBeVisible();
      // Scroll only the transcript during setup: the real Collapse click must
      // be the action that exposes ancestor scrolling in the old handler.
      await page.locator('#messages').evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const viewportTop = await page.locator('#messages').evaluate((node) => node.getBoundingClientRect().top);
      expect((await summary.boundingBox()).y).toBeLessThan(viewportTop);
      await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
      await collapse.click();
      await expect(details).not.toHaveAttribute('open', '');
      await expect(summary).toBeFocused();
      await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
      await expect.poll(async () => (await composer.boundingBox()).y).toBeCloseTo(initial.y, 0);
      const box = await summary.boundingBox();
      const messages = await page.locator('#messages').boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(messages.y);
      expect(box.y + box.height).toBeLessThanOrEqual(messages.y + messages.height);
    }
  });
}

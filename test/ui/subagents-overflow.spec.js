'use strict';

const { test, expect } = require('./fixture');

test('subagents stay collapsed until opened and respect the manual toggle across runs', async ({ page, chat }) => {
  const send = running => chat.send({ type: 'subagents', items: [{ id: 'child', title: 'Review', running, result: 'Finished' }] });
  const summary = page.locator('#subagents-summary');
  const list = page.locator('#subagents-list');
  await send(true);
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  await send(false);
  await send(true);
  await expect(list).toBeHidden();
  await summary.click();
  await send(false);
  await send(true);
  await expect(list).toBeVisible();
  await summary.click();
  await send(false);
  await send(true);
  await expect(list).toBeHidden();
});

test('wide transcript content never enables horizontal scrolling of the chat', async ({ page, chat }) => {
  const wide = 'long_unbroken_value_'.repeat(200);
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\`\`\`cpp\n${wide}\n\`\`\`\n\n| Value |\n| --- |\n| ${wide} |` } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await chat.send({ type: 'subagents', items: [{ id: 'child', title: wide, running: false, result: wide }] });
  await page.locator('#subagents-summary').click();
  for (const selector of ['#messages', '#subagents-list']) {
    expect(await page.locator(selector).evaluate(node => getComputedStyle(node).overflowX)).toBe('hidden');
  }
  // Wide code stays accessible in its own viewport, not through the transcript.
  expect(await page.locator('.md pre').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
});

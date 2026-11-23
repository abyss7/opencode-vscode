'use strict';

const { test, expect } = require('./fixture');

test('completed answers copy source Markdown without rendered visuals', async ({ page, chat }) => {
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text) => { window.copiedAnswer = text; } },
    configurable: true,
  }));
  const send = (messageId, text) => chat.update({
    sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
  });
  const end = () => chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  const prefix = '- **keep** `![literal](x)` and [link](x)\n';
  const source = `${prefix}\n![nested](foo(bar).png)\n\n~~~mermaid\ngraph LR; A-->B\n~~~\n\nAfter.[^1]\n\n[^1]: [![badge][img]](target)note\n\n[img]: img.png`;
  await send('first', source);
  const buttons = page.locator('.answer-copy');
  await expect(buttons).toHaveCount(0);
  await end();
  await expect(buttons.first().locator('..')).toHaveCSS('opacity', '1');
  await send('second', 'Second answer');
  await end();
  await expect(buttons).toHaveCount(2);
  await expect(buttons.first().locator('..')).toHaveCSS('opacity', '0');
  await buttons.first().focus();
  await expect(buttons.first().locator('..')).toHaveCSS('opacity', '1');
  await buttons.first().press('Enter');
  await expect(buttons.first()).toHaveAccessibleName('Copied');
  expect(await page.evaluate(() => window.copiedAnswer)).toBe(`${prefix}\n\n\n\n\nAfter.[^1]\n\n[^1]: note\n\n`);
  await buttons.last().click();
  expect(await page.evaluate(() => window.copiedAnswer)).toBe('Second answer');
});

test('native history replay offers actions only for completed messages', async ({ page, chat }) => {
  const message = { id: 'answer', type: 'assistant', time: { created: 1 },
    content: [{ type: 'text', text: 'Still writing' }] };
  await chat.send({ type: 'historyReset' }, { type: 'transcript', messages: [message] }, { type: 'historyEnd' });
  await expect(page.locator('.assistant .body')).toHaveText('Still writing');
  await expect(page.locator('.answer-copy')).toHaveCount(0);
  message.time.completed = 2;
  message.content[0].text = 'Done';
  await chat.send({ type: 'transcript', messages: [message] });
  await expect(page.locator('.answer-copy')).toHaveCount(1);
  const button = page.locator('.answer-copy');
  const box = await button.boundingBox();
  const ink = await button.locator('path').boundingBox();
  expect(ink.width).toBeGreaterThanOrEqual(10);
  expect(ink.height).toBeGreaterThanOrEqual(10);
  expect(Math.abs(ink.x + ink.width / 2 - box.x - box.width / 2)).toBeLessThan(1);
  expect(Math.abs(ink.y + ink.height / 2 - box.y - box.height / 2)).toBeLessThan(1);
});

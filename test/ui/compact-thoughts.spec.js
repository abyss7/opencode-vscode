'use strict';

const { test, expect } = require('./fixture');
const thought = (chat, text, messageId = 'thought') => chat.update({ sessionUpdate: 'agent_thought_chunk',
  messageId, content: { type: 'text', text } });
const finish = (chat) => chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
const expandSteps = (page) => page.locator('.turn-steps').evaluateAll((blocks) => {
  for (const block of blocks) block.open = true;
});

test('one-line thoughts appear directly and retain their step and token counts', async ({ page, chat }) => {
  await thought(chat, '**Checking the layout**');
  await finish(chat);
  const tokens = await page.locator('.turn-steps > summary > .tokens').textContent();
  await expandSteps(page);
  await expect(page.locator('.thought')).toHaveClass(/compact/);
  await expect(page.locator('.thought > summary')).toBeHidden();
  await expect(page.locator('.thought > .body')).toBeVisible();
  await expect(page.locator('.thought > .body')).toHaveText('Checking the layout');
  await expect(page.locator('.turn-steps > summary > .kind')).toHaveText('1 step');
  await expect(page.locator('.turn-steps > summary > .tokens')).toHaveText(tokens);
  await chat.snapshot('compact-thought');
});

test('streaming text becomes collapsible when it grows to multiple lines', async ({ page, chat }) => {
  await thought(chat, 'Checking');
  await expandSteps(page);
  await expect(page.locator('.thought')).toHaveClass(/compact/);
  const rest = '\n' + 'Detailed reasoning. '.repeat(40);
  await thought(chat, rest);
  await expect(page.locator('.thought')).not.toHaveClass(/compact/);
  await finish(chat);
  await expect(page.locator('.thought > summary')).toBeVisible();
  await expect(page.locator('.thought > .body')).toBeHidden();
  await page.locator('.thought > summary').click();
  await expect(page.locator('.thought > .body')).toHaveText('Checking' + rest);
});

test('single-line source is folded if it does not fit and adapts to viewport changes', async ({ page, chat }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const text = 'Checking the layout, permissions and navigation before completing the interface update';
  await thought(chat, '**' + text + '**');
  await finish(chat);
  await expandSteps(page);
  await expect(page.locator('.thought')).toHaveClass(/compact/);
  await expect(page.locator('.thought > .body')).toHaveText(text);
  await page.setViewportSize({ width: 380, height: 900 });
  await expect(page.locator('.thought')).not.toHaveClass(/compact/);
  await expect(page.locator('.thought > summary')).toBeVisible();
  await expect(page.locator('.thought > .body')).toBeHidden();
  await page.locator('.thought > summary').click();
  await expect(page.locator('.thought > .body')).toHaveText('**' + text + '**');
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator('.thought')).toHaveClass(/compact/);
  await page.setViewportSize({ width: 380, height: 900 });
  await expect(page.locator('.thought')).not.toHaveClass(/compact/);
  await expect(page.locator('.thought > .body')).toBeVisible();
});

test('replayed thoughts are classified when their outer steps expand and text remains safe', async ({ page, chat }) => {
  await thought(chat, 'Old status');
  await finish(chat);
  await chat.send({ type: 'historyReset' });
  await thought(chat, '**<script>unsafe()</script>**', 'restored');
  await chat.send({ type: 'historyEnd' });
  await expandSteps(page);
  await expect(page.locator('.thought')).toHaveCount(1);
  await expect(page.locator('.thought')).toHaveClass(/compact/);
  await expect(page.locator('.thought > .body')).toHaveText('<script>unsafe()</script>');
  await expect(page.locator('.thought script')).toHaveCount(0);
});

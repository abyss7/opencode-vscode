'use strict';

const { test, expect } = require('./fixture');
const chunk = (chat, text) => chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

test('visible plan progress opens the latest plan and survives a completed answer', async ({ page, chat }) => {
  const entries = [{ content: 'Read sources', status: 'completed' }, { content: 'Check behavior', status: 'in_progress' }, { content: 'Summarize', status: 'pending' }];
  await chat.update({ sessionUpdate: 'plan', entries });
  await expect(page.locator('#plan-progress-text')).toHaveText('1/3 · Check behavior');
  await page.getByRole('button', { name: 'Show plan' }).click();
  await expect(page.locator('.plan-entries')).toBeVisible();
  await chat.update({ sessionUpdate: 'plan', entries: entries.map((entry) => ({ ...entry, status: 'completed' })) });
  await chunk(chat, 'All steps completed.');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('#plan-progress-text')).toHaveText('3/3 · Plan complete');
  await expect(page.getByRole('progressbar', { name: 'Plan completion' })).toHaveAttribute('value', '3');
  await chat.snapshot('plan-progress');
});

test('answers stay hidden until complete', async ({ page, chat }) => {
  await chunk(chat, 'Default answer\n\n');
  await expect(page.locator('.assistant')).toBeHidden();
  await chunk(chat, '```js\nconst x =');
  await expect(page.locator('.code-block')).toHaveCount(0);
  await chunk(chat, ' 1;\n```\n');
  await expect(page.locator('.assistant')).toBeHidden();
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.assistant .code-block')).toHaveCount(1);
  await expect(page.locator('.assistant')).toContainText('const x = 1;');
});

test('completed answers render tables and Mermaid sources', async ({ page, chat }) => {
  await chunk(chat, '| Name | Count |\n| --- | --- |\n| a |');
  await expect(page.locator('.assistant table')).toHaveCount(0);
  await chunk(chat, ' 2 |\n\nDone.\n\n```mermaid\nflowchart LR\nA-->');
  await expect(page.locator('.assistant table')).toHaveCount(0);
  await expect(page.locator('.assistant .diagram')).toHaveCount(0);
  await chunk(chat, 'B\n```\n');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.assistant table')).toBeVisible();
  await expect(page.locator('.assistant .diagram')).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
});

test('long answer outline navigates by keyboard', async ({ page, chat }) => {
  await chunk(chat, Array.from({ length: 5 }, (_, i) => `## Section ${i + 1}\n\n${'Readable paragraph. '.repeat(20)}\n\n`).join(''));
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.locator('.answer-outline summary').click();
  const target = page.getByRole('button', { name: 'Section 5', exact: true });
  await target.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Section 5' })).toBeFocused();
  expect(await page.locator('#messages').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await chat.snapshot('answer-outline');
});

test('finished subagents show result excerpts and open their session', async ({ page, chat }) => {
  await chat.send({ type: 'subagents', items: [{ id: 'ses_child', title: 'Review', running: false, result: 'Found one missing timeout.', tokens: 42 }] });
  await page.locator('#subagents-summary').click();
  await expect(page.locator('.subagent-result')).toHaveText('Found one missing timeout.');
  await page.locator('.subagent').focus();
  await page.keyboard.press('Enter');
  expect(await chat.received('openSession')).toEqual([{ type: 'openSession', sessionId: 'ses_child' }]);
});

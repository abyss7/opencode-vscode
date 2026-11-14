'use strict';

const { test, expect } = require('./fixture');

const artifact = (version) => '```opencode-artifact\n' + JSON.stringify({
  schema: 1, id: 'pane-doc', version, title: 'Pane document', kind: 'markdown',
  content: Array.from({ length: 40 }, (_, i) => `## Chapter ${i + 1}\n\n${'Detailed artifact paragraph. '.repeat(30)}\n\n`).join(''),
}) + '\n```';
const answer = async (chat, text) => {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
};

test('artifact pane keeps its scroll through no-op ingests and real updates', async ({ page, chat }) => {
  await answer(chat, artifact(1));
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  const pane = page.locator('#artifacts');
  await expect(pane).toBeVisible();
  await pane.evaluate((node) => { node.scrollTop = Math.round(node.scrollHeight / 2); });
  const parked = await pane.evaluate((node) => node.scrollTop);
  expect(parked).toBeGreaterThan(100);

  // An unrelated answer completes: ingest finds nothing new and must not
  // touch — let alone scroll-reset — the open pane.
  await answer(chat, 'Plain answer with no artifacts.');
  await page.waitForTimeout(120);
  expect(await pane.evaluate((node) => node.scrollTop)).toBe(parked);

  // A new version of the same artifact really redraws the pane.
  await answer(chat, artifact(2));
  await page.waitForTimeout(120);
  expect(await pane.evaluate((node) => node.scrollTop)).toBe(parked);
  expect(await pane.evaluate((node) => node.textContent)).toContain('Chapter 40');
});

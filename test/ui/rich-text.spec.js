'use strict';

const { test, expect } = require('./fixture');

async function answer(chat, text) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}

test('nested Markdown, callouts, tasks and unique footnotes', async ({ page, chat }) => {
  const text = [
    '## Implementation options', '',
    '1. Render results', '   - Keep the source', '   - Show a preview', '2. Discuss the result', '',
    '- [x] Browser checks', '- [ ] Diagram renderer', '',
    '> [!NOTE]', '> The preview follows your editor theme.', '',
    'A measured result[^source].', '',
    '[^source]: Based on the local benchmark.',
  ].join('\n');
  await answer(chat, text);
  await expect(page.locator('.md ol > li > ul > li')).toHaveCount(2);
  await expect(page.locator('.md input[type=checkbox]').first()).toBeChecked();
  await expect(page.locator('.md input[type=checkbox]').last()).not.toBeChecked();
  await expect(page.locator('.md input[type=checkbox]').first()).toBeDisabled();
  await expect(page.locator('.callout-note')).toContainText('The preview follows your editor theme.');
  await expect(page.locator('.callout-label')).toHaveText('Note');
  await chat.snapshot('rich-answer');
  await answer(chat, text);
  const ids = await page.locator('.footnote-item').evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(2);
  await page.locator('.footnote-ref a').last().click();
  await expect(page.locator('.footnote-item').last()).toBeInViewport();
});

test('highlighted code copies exact source and unknown languages stay readable', async ({ page, context, chat }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await answer(chat, '```js\nconst html = "<div>";\nconsole.log(html);\n```\n\n```unknown-language\n<tag>&literal\n```');
  await expect(page.locator('.hljs-keyword')).toHaveText('const');
  await expect(page.locator('.code-language').first()).toHaveText('js');
  await page.getByRole('button', { name: 'Copy code' }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const html = "<div>";\nconsole.log(html);');
  await expect(page.locator('.code-copy').first()).toHaveText('Copied');
  await expect(page.locator('.md pre').last()).toHaveText('<tag>&literal');
});

test('wide code and aligned tables scroll locally without moving the composer', async ({ page, chat }) => {
  await answer(chat, `| Name | Count |\n| :--- | ---: |\n| queue | 42 |\n\n\`\`\`text\n${'long_value_'.repeat(80)}\n\`\`\``);
  await expect(page.locator('th').last()).toHaveCSS('text-align', 'right');
  await expect(page.locator('td').last()).toHaveCSS('text-align', 'right');
  expect(await page.locator('.md pre').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.locator('#messages').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.locator('#input')).toBeInViewport();
});

test('Markdown preserves trusted file links and never executes supplied HTML', async ({ page, chat }) => {
  await answer(chat, '[**API**](src/api.js#L42) and [unknown](missing.js)\n\n[bad](javascript:alert(1))\n\n<img src=x onerror="window.injected=true">\n\nhttps://example.com/src/api.js');
  await expect(page.locator('.file-link strong')).toHaveText('API');
  await expect(page.locator('.file-link')).toHaveCount(1);
  await expect(page.locator('.md img')).toHaveCount(0);
  await expect(page.locator('.md a[data-href]')).toHaveAttribute('data-href', 'https://example.com/src/api.js');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

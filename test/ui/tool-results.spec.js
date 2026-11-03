'use strict';

const { test, expect } = require('./fixture');

async function show(chat, page, update) {
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'typed-1', title: 'Typed result', kind: 'edit', status: 'completed', ...update });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  for (const selector of ['details.turn-steps', 'details.tool-group', 'details.tool-entry']) {
    for (const item of await page.locator(`${selector}:not([open]) > summary`).all()) await item.click();
  }
}

test('diff shows edits with both line numbers and opens exact immutable texts', async ({ page, chat }) => {
  const change = { type: 'diff', path: 'src/example.js', oldText: 'const x = 1;\nkeep();\n', newText: 'const x = 2;\nkeep();\n<script>alert(1)</script>\n' };
  await show(chat, page, { content: [change] });
  await expect(page.locator('.removed .diff-code')).toHaveText('const x = 1;');
  await expect(page.locator('.added .diff-code')).toHaveText(['const x = 2;', '<script>alert(1)</script>']);
  await expect(page.locator('.context .line-number')).toHaveText(['2', '2']);
  await page.getByRole('button', { name: 'Open diff', exact: true }).click();
  expect(await chat.received('openDiff')).toEqual([{ ...change, type: 'openDiff' }]);
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'typed-1', status: 'completed' });
  await expect(page.locator('.tool-diff')).toHaveCount(1);
  expect(await page.locator('#messages').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await chat.snapshot('typed-diff');
});

test('long context folds without losing lines and null old text creates a file', async ({ page, chat }) => {
  const context = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
  await show(chat, page, { content: [
    { type: 'diff', path: 'a.txt', oldText: context + 'before', newText: context + 'after' },
    { type: 'diff', path: 'new.txt', oldText: null, newText: 'created\n' },
  ] });
  await page.getByRole('button', { name: 'Show 34 unchanged lines' }).click();
  await expect(page.locator('.context')).toHaveCount(40);
  await expect(page.locator('.tool-diff').last().locator('.added .line-number')).toHaveText(['', '1']);
});

test('structured data sorts numerically and nested values expand', async ({ page, chat }) => {
  await show(chat, page, { rawOutput: { measurements: [{ name: 'slow', ms: 100 }, { name: 'fast', ms: 2 }], metadata: { unit: 'ms' } } });
  await page.locator('.result-tree > details').first().locator('summary').first().click();
  await page.getByRole('button', { name: 'ms', exact: true }).click();
  await expect(page.locator('.result-table tbody tr').first()).toHaveText('fast2');
  await page.getByRole('button', { name: 'ms', exact: true }).click();
  await expect(page.locator('.result-table tbody tr').first()).toHaveText('slow100');
});

test('typed diagnostics preserve file coordinates and unknown types retain fallback', async ({ page, chat }) => {
  await show(chat, page, { rawOutput: { type: 'diagnostics', items: [
    { path: 'src/a.js', line: 12, column: 4, severity: 'error', message: 'Unknown symbol' },
  ] } });
  await page.getByRole('button', { name: '12 · error' }).click();
  expect(await chat.received('openFile')).toEqual([{ type: 'openFile', path: 'src/a.js', line: 12, column: 4 }]);
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'typed-1', content: [{ type: 'future', payload: 'keep this' }] });
  await expect(page.locator('.tool-text')).toContainText('keep this');
});

test('ACP image previews zoom and text stays literal', async ({ page, chat }) => {
  await show(chat, page, { content: [
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } },
    { type: 'content', content: { type: 'text', text: '<b>literal</b>' } },
  ] });
  await expect(page.locator('.tool-image img')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom image' }).click();
  await expect(page.locator('.tool-image')).toHaveClass(/zoomed/);
  await expect(page.locator('.tool-text')).toHaveText('<b>literal</b>');
});

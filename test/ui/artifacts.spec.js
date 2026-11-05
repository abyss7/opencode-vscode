'use strict';

const { test, expect } = require('./fixture');
const artifact = (overrides = {}) => ({ schema: 1, id: 'latency', version: 1, title: 'Latency', kind: 'chart', chart: 'line', xLabel: 'Requests', yLabel: 'Duration', unit: 'ms', series: [{ name: 'Measured', values: [{ x: 1, y: 12 }, { x: 2, y: 8 }, { x: 3, y: 10 }] }], ...overrides });
async function answer(chat, value) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '```opencode-artifact\n' + JSON.stringify(value) + '\n```' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}

test('artifacts retain revisions, preview/source and exact export payload', async ({ page, chat }) => {
  const first = artifact({ source: { path: 'bench/results.json', line: 3 } });
  await answer(chat, first);
  await page.getByRole('button', { name: 'Latency · v1 · chart' }).click();
  await expect(page.locator('.artifact-chart')).toBeVisible();
  await expect(page.locator('.artifact-chart')).toContainText('Duration (ms)');
  const chartWidth = (await page.locator('.artifact-chart').boundingBox()).width;
  expect(16 * chartWidth / 640).toBeGreaterThanOrEqual(12);
  await page.locator('.chart-data summary').click();
  await expect(page.locator('#artifacts .result-table tbody tr')).toHaveCount(3);
  await chat.snapshot('artifact-chart');
  await answer(chat, artifact({ version: 2, series: [{ name: 'Measured', values: [{ x: 1, y: 4 }] }] }));
  await expect(page.getByLabel('Artifact version', { exact: true })).toHaveValue('2');
  await page.getByLabel('Artifact version', { exact: true }).selectOption('1');
  await page.locator('#artifacts').getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.locator('.artifact-source')).toContainText('"y":12');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const sent = await chat.received('exportArtifact');
  expect(JSON.parse(sent[0].content)).toEqual(first);
  await page.getByRole('button', { name: 'Open source file' }).click();
  expect(await chat.received('openFile')).toEqual([{ type: 'openFile', path: 'bench/results.json', line: 3 }]);
  await page.getByRole('button', { name: 'Close artifacts' }).click();
  await expect(page.locator('#artifacts')).toBeHidden();
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  await expect(page.getByLabel('Artifact version', { exact: true })).toHaveValue('1');
  const composer = await page.locator('#composer').boundingBox();
  expect(composer.y + composer.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
});

test('history replay rebuilds artifacts without duplicating versions', async ({ page, chat }) => {
  await answer(chat, artifact());
  await page.getByRole('button', { name: 'Latency · v1 · chart' }).click();
  await chat.send({ type: 'historyReset' });
  await answer(chat, artifact());
  await chat.send({ type: 'historyEnd' });
  await expect(page.locator('#artifacts')).toBeVisible();
  await expect(page.getByLabel('Artifact version', { exact: true }).locator('option')).toHaveCount(1);
  await expect(page.locator('.artifact-chart')).toBeVisible();
});

test('invalid and conflicting artifacts keep readable JSON, valid diagrams render', async ({ page, chat }) => {
  await answer(chat, artifact({ unit: undefined }));
  await expect(page.locator('.artifact-reference .visual-error')).toContainText('unit');
  await expect(page.locator('.artifact-reference pre')).toBeVisible();
  const diagram = artifact({ id: 'flow', title: 'Flow', kind: 'mermaid', content: 'flowchart LR\nA[Start] --> B[End]' });
  await answer(chat, diagram);
  await page.getByRole('button', { name: 'Flow · v1 · mermaid' }).click();
  await expect(page.locator('#artifacts .diagram')).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  await answer(chat, { ...diagram, content: 'flowchart LR\nX-->Y' });
  await expect(page.locator('.artifact-reference .visual-error').last()).toContainText('new version number');
});

test('Markdown artifacts keep code copy and verified file links working', async ({ page, context, chat }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await answer(chat, artifact({ id: 'note', title: 'Note', kind: 'markdown', content: 'See `src/api.js:42`.\n\n```js\nconst x = 1;\n```' }));
  await page.getByRole('button', { name: 'Note · v1 · markdown' }).click();
  await expect(page.locator('#artifacts .file-link')).toBeVisible();
  await page.locator('#artifacts .file-link').click();
  expect((await chat.received('openFile'))[0]).toMatchObject({ path: 'src/api.js', line: 42 });
  await page.locator('#artifacts .code-copy').click();
  await expect(page.locator('#artifacts .code-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const x = 1;');
});

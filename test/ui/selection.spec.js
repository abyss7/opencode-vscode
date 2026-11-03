'use strict';

const { test, expect } = require('./fixture');

async function artifact(chat, value) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '```opencode-artifact\n' + JSON.stringify({ schema: 1, id: 'object', version: 1, title: 'Object', ...value }) + '\n```' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}
async function open(page, kind) {
  await page.getByRole('button', { name: `Object · v1 · ${kind}` }).click();
}
async function ask(page, chat, text = 'Why this part?') {
  await page.getByRole('button', { name: 'Ask about selection' }).click();
  await page.locator('#input').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  return (await chat.received('prompt')).at(-1);
}

test('chart selection stays tied to its original version as the artifact changes', async ({ page, chat }) => {
  const chart = { kind: 'chart', chart: 'bar', xLabel: 'Batch', yLabel: 'Duration', unit: 'ms', series: [{ name: 'Measured', values: [{ x: 1, y: 12 }, { x: 2, y: -3 }] }] };
  await artifact(chat, chart);
  await open(page, 'chart');
  await page.locator('[data-series="Measured"]').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Ask about selection' }).click();
  await artifact(chat, { ...chart, version: 2 });
  await page.locator('#input').fill('Why this part?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const prompt = (await chat.received('prompt')).at(-1);
  expect(prompt.selection.artifact.version).toBe(1);
  expect(prompt.selection.selection).toEqual({ type: 'chart-series', name: 'Measured', values: chart.series[0].values, unit: 'ms' });
  await expect(page.locator('#selection-context')).toBeHidden();
});

test('diagram nodes are keyboard selectable and carry label and source', async ({ page, chat }) => {
  const content = 'flowchart LR\nA[Queue] --> B[Worker]';
  await artifact(chat, { kind: 'mermaid', content });
  await open(page, 'mermaid');
  const node = page.getByRole('button', { name: 'Select node Queue', exact: true });
  await expect(node).toBeVisible({ timeout: 15000 });
  await node.focus();
  await page.keyboard.press('Enter');
  const prompt = await ask(page, chat);
  expect(prompt.selection.selection).toMatchObject({ type: 'diagram-node', label: 'Queue' });
  expect(prompt.selection.artifact.content).toBe(content);
});

test('diff selection includes exact before/after coordinates over a range', async ({ page, chat }) => {
  await artifact(chat, { kind: 'diff', path: 'a.js', oldText: 'old\nkeep\n', newText: 'new\nkeep\n' });
  await open(page, 'diff');
  await page.locator('.diff-lines .removed').click();
  await page.locator('.diff-lines .added').click({ modifiers: ['Shift'] });
  const prompt = await ask(page, chat);
  expect(prompt.selection.selection).toEqual({ type: 'diff-lines', path: 'a.js', lines: [
    { oldLine: 1, newLine: null, change: 'removed', text: 'old' },
    { oldLine: null, newLine: 1, change: 'added', text: 'new' },
  ] });
});

test('image regions support pointer and numeric selection, annotation, crop and overview', async ({ page, chat }) => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00aa00'; ctx.fillRect(0, 0, 200, 100);
    ctx.fillStyle = '#0044ff'; ctx.fillRect(50, 25, 100, 50);
    return canvas.toDataURL();
  });
  await artifact(chat, { kind: 'image', dataUrl });
  await open(page, 'image');
  const image = page.locator('#artifacts .tool-image img');
  await expect(image).toBeVisible();
  const box = await image.boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 3 / 4, box.y + box.height * 3 / 4);
  await page.mouse.up();
  await expect(page.getByLabel('Region x', { exact: true })).toHaveValue('50');
  await expect(page.getByLabel('Region width', { exact: true })).toHaveValue('100');
  await page.getByLabel('Region width', { exact: true }).fill('80');
  await page.getByLabel('Region width', { exact: true }).press('Tab');
  await page.getByLabel('Image annotation').fill('Blue rectangle');
  await chat.snapshot('image-region');
  const prompt = await ask(page, chat);
  expect(prompt.selection.selection).toMatchObject({ type: 'image-region', x: 50, y: 25, width: 80, height: 50, imageWidth: 200, imageHeight: 100, annotation: 'Blue rectangle' });
  expect(prompt.selection.artifact.dataUrl).toBeUndefined();
  expect(prompt.images).toHaveLength(2);
  const dimensions = await page.evaluate(async (images) => Promise.all(images.map(async (item) => {
    const img = new Image(); img.src = `data:${item.mimeType};base64,${item.data}`; await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  })), prompt.images);
  expect(dimensions).toEqual([[80, 50], [200, 100]]);
});

test('removing a selection removes its generated attachments', async ({ page, chat }) => {
  await artifact(chat, { kind: 'markdown', content: 'Some text' });
  await open(page, 'markdown');
  await page.getByRole('button', { name: 'Ask about selection' }).click();
  await page.getByRole('button', { name: 'Remove selection' }).click();
  await page.locator('#input').fill('Ordinary question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const prompt = (await chat.received('prompt')).at(-1);
  expect(prompt.selection).toBeUndefined();
  expect(prompt.images).toEqual([]);
});

test('restored screenshot attachments can be inspected and cropped', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'user-image', content: { type: 'text', text: 'Look at this screenshot' } });
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'user-image', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } });
  await expect(page.locator('.message.user')).toHaveCount(1);
  await page.getByRole('button', { name: 'Inspect Image', exact: true }).click();
  await expect(page.getByLabel('Region width', { exact: true })).toHaveValue('1');
  const prompt = await ask(page, chat);
  expect(prompt.selection.artifact.origin.messageId).toBe('user-image');
  expect(prompt.images).toHaveLength(2);
});

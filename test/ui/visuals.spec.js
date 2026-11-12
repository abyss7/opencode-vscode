'use strict';

const { test, expect } = require('./fixture');

async function answer(chat, text) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}

test('Mermaid renders offline and switches between preview and source', async ({ page, chat }) => {
  await answer(chat, '## Request lifecycle\n\n```mermaid\nflowchart LR\n  A[Client] --> B[Queue]\n  B --> C[Worker]\n```');
  await expect(page.locator('.diagram')).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  await expect(page.locator('.diagram-preview svg')).toBeVisible();
  await expect(page.locator('.diagram-preview')).toContainText('Queue');
  await chat.snapshot('diagram');
  const initial = await page.locator('.diagram-preview svg').boundingBox();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect((await page.locator('.diagram-preview svg').boundingBox()).width).toBeGreaterThan(initial.width);
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  expect((await page.locator('.diagram-preview svg').boundingBox()).width).toBeLessThanOrEqual((await page.locator('.diagram-preview').boundingBox()).width);
  await chat.snapshot('diagram-fit');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.locator('.diagram-preview')).toBeHidden();
  await expect(page.locator('.visual-source-panel')).toContainText('A[Client] --> B[Queue]');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.diagram-preview svg')).toBeVisible();
  expect(await page.locator('#messages').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('invalid diagram keeps its source and does not prevent later diagrams', async ({ page, chat }) => {
  await answer(chat, '```mermaid\nnot-a-diagram ???\n```\n\n```mermaid\nsequenceDiagram\nClient->>Server: Request\nServer-->>Client: Reply\n```');
  await expect(page.locator('.diagram').first()).toHaveAttribute('data-rendered', 'error', { timeout: 15000 });
  await expect(page.locator('.visual-source-panel').first()).toBeVisible();
  await expect(page.locator('.diagram').last()).toHaveAttribute('data-rendered', 'ready');
  await expect(page.locator('.diagram-preview').last()).toContainText('Request');
});

test('formulas expose LaTeX source and currency and code remain literal', async ({ page, chat }) => {
  await answer(chat, 'Inline: $E=mc^2$. Cost: $5 and $10.\n\n$$\nG = \\frac{M}{N} + \\sum_{i=1}^{n} x_i\n$$\n\n`$literal$`\n\n\\(a^2+b^2=c^2\\)');
  await expect(page.locator('.katex')).toHaveCount(3);
  await expect(page.locator('.md')).toContainText('Cost: $5 and $10.');
  await expect(page.locator('.md p code')).toHaveText('$literal$');
  await page.locator('.math-source summary').click();
  await expect(page.locator('.math-source code')).toContainText('\\frac{M}{N}');
  expect(await page.locator('#messages').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('diagram theme picker defaults to dark and preserves zoom and source independently of the editor', async ({ page, chat }) => {
  await answer(chat, '```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```');
  const block = page.locator('.diagram');
  const preview = block.locator('.diagram-preview');
  const picker = block.getByRole('combobox', { name: 'Diagram theme' });
  await expect(block).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  await expect(picker).toHaveValue('dark');
  await expect(preview).toHaveCSS('background-color', 'rgb(51, 51, 51)');
  const darkFill = await preview.locator('.node rect').first().evaluate(node => getComputedStyle(node).fill);
  await block.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const scale = await block.getAttribute('data-scale');
  await block.getByRole('button', { name: 'Source', exact: true }).click();
  let before = await preview.locator('svg').getAttribute('id');
  await picker.selectOption('forest');
  await expect(preview.locator('svg')).not.toHaveAttribute('id', before);
  await expect(block).toHaveAttribute('data-rendered', 'ready');
  await expect(preview).toBeHidden();
  await expect(block).toHaveAttribute('data-scale', scale);
  await expect(block.locator('.visual-source-panel')).toContainText('A[Start]');
  await block.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(preview).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(await preview.locator('.node rect').first().evaluate(node => getComputedStyle(node).fill)).not.toBe(darkFill);
  before = await preview.locator('svg').getAttribute('id');
  await page.evaluate(() => {
    document.body.classList.toggle('vscode-light');
    document.body.style.setProperty('--vscode-foreground', '#ff00ff');
  });
  await expect(picker).toHaveValue('forest');
  await expect(preview).toHaveAttribute('data-theme', 'forest');
  await expect(preview.locator('svg')).toHaveAttribute('id', before);
  expect(await page.locator('#messages').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await chat.snapshot('diagram-forest');
});

test('all built-in diagram themes render offline and rapid switches keep the latest selection', async ({ page, chat }) => {
  await answer(chat, '```mermaid\nflowchart LR\nA[Client] --> B[Queue]\n```\n\n```mermaid\nsequenceDiagram\nClient->>Worker: Execute\n```');
  const blocks = page.locator('.diagram');
  await expect(blocks.first()).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  await expect(blocks.last()).toHaveAttribute('data-rendered', 'ready');
  const picker = blocks.first().getByRole('combobox', { name: 'Diagram theme' });
  const ids = await picker.locator('option').evaluateAll(options => options.map(option => option.value));
  for (const id of ids) {
    const preview = blocks.first().locator('.diagram-preview');
    const before = await preview.locator('svg').getAttribute('id');
    await picker.selectOption(id);
    await expect(preview.locator('svg')).not.toHaveAttribute('id', before);
    await expect(blocks.first()).toHaveAttribute('data-rendered', 'ready');
    await expect(preview).toHaveAttribute('data-theme', id);
    await expect(blocks.last().locator('.diagram-preview')).toHaveAttribute('data-theme', 'dark');
  }
  await picker.evaluate(select => {
    for (const value of ['forest', 'neutral', 'dark']) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(blocks.first()).toHaveAttribute('data-rendered', 'ready');
  await expect(blocks.first().locator('.diagram-preview')).toHaveAttribute('data-theme', 'dark');
  await chat.snapshot('diagram-dark');
});

test('ELK lays out grouped nodes with rich HTML and Mermaid Markdown labels', async ({ page, chat }) => {
  const source = [
    'flowchart LR',
    'subgraph KQP[Compilation and execution]',
    'A["<b>Predictor</b><br/><i>Stages</i><br/><code>TStagePredictor</code><br/>x<sub>1</sub> + y<sup>2</sup>"]',
    'B["`**Worker**',
    '*Execute* tasks`"]',
    'A --> B',
    'end',
    'C[Storage] --> A',
  ].join('\n');
  await answer(chat, '```mermaid\n' + source + '\n```');
  await expect(page.locator('.diagram')).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  const preview = page.locator('.diagram-preview');
  // The diagram type stays flowchart-v2 even when ELK provides the layout.
  await expect(preview.locator('svg')).toHaveAttribute('aria-roledescription', 'flowchart-v2');
  await expect(preview.locator('b, strong').filter({ hasText: 'Predictor' })).toBeVisible();
  await expect(preview.locator('i, em').filter({ hasText: 'Stages' })).toBeVisible();
  await expect(preview.locator('code')).toHaveText('TStagePredictor');
  await expect(preview.locator('sub')).toHaveText('1');
  await expect(preview.locator('sup')).toHaveText('2');
  await expect(preview.locator('b, strong').filter({ hasText: 'Worker' })).toBeVisible();
  await expect(preview.locator('i, em').filter({ hasText: 'Execute' })).toBeVisible();
  expect(await preview.locator('foreignObject').filter({ has: page.locator('code') }).evaluate(node => {
    const code = node.querySelector('code').getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return code.width <= bounds.width + 1;
  })).toBe(true);
  await chat.snapshot('diagram-rich-labels');
});

test('diagram label formatting cannot load resources or override the sanitizer', async ({ page, chat }) => {
  const source = [
    '%%{init: {"securityLevel":"loose","theme":"forest","dompurifyConfig":{"ALLOWED_TAGS":["img","a","style"]}}}%%',
    'flowchart LR',
    'A["<b>Safe</b><img src=\'https://invalid.example/image.png\' onerror=\'window.diagramUnsafe=true\'/><a href=\'javascript:alert(1)\'>Link</a><span style=\'background-image:url(https://invalid.example/bg.png)\' onclick=\'window.diagramUnsafe=true\'>Text</span>"] --> B[Done]',
  ].join('\n');
  await answer(chat, '```mermaid\n' + source + '\n```');
  await expect(page.locator('.diagram')).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  const preview = page.locator('.diagram-preview');
  await expect(preview.locator('b')).toHaveText('Safe');
  await expect(preview.locator('img, image, a, script, iframe, [onclick], [onerror]')).toHaveCount(0);
  expect(await preview.locator('foreignObject').evaluateAll(nodes => nodes.every(node => !node.innerHTML.includes('invalid.example')))).toBe(true);
  expect(await page.evaluate(() => window.diagramUnsafe)).toBeUndefined();
  await expect(preview).toHaveAttribute('data-theme', 'dark');
});

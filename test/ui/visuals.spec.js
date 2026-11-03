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

test('theme change rerenders existing diagrams without losing the source', async ({ page, chat }) => {
  await answer(chat, '```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```');
  await expect(page.locator('.diagram')).toHaveAttribute('data-rendered', 'ready', { timeout: 15000 });
  const before = await page.locator('.diagram-preview svg').getAttribute('id');
  await page.evaluate(() => {
    document.body.classList.toggle('vscode-light');
    document.body.style.setProperty('--vscode-foreground', '#ff00ff');
  });
  await expect(page.locator('.diagram-preview svg')).not.toHaveAttribute('id', before);
  await expect(page.locator('.diagram')).toHaveAttribute('data-rendered', 'ready');
  await expect(page.locator('.visual-source-panel')).toContainText('A[Start]');
});

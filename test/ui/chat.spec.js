'use strict';

const { test, expect } = require('./fixture');

test('formatted answer, verified file links and external links', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Explain the request flow.' } });
  await chat.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: [
      '## Request flow',
      '',
      'The **client** sends a request to `src/api.js:42`. Unknown: `missing.js:8`.',
      '',
      '- Validate input',
      '- Return the result',
      '',
      '| Stage | State |',
      '| --- | --- |',
      '| Client | Ready |',
      '| Server | Connected |',
      '',
      '```js',
      'const result = await api.get();',
      '```',
      '',
      '> Keep the interface predictable.',
      '',
      '[Reference](https://example.com/docs)',
      '',
      '<script>window.untrusted = true</script>',
    ].join('\n') },
  });
  await expect(page.locator('.assistant')).toBeHidden();
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.getByRole('heading', { name: 'Request flow' })).toBeVisible();
  await expect(page.locator('.md strong')).toHaveText('client');
  await expect(page.locator('.md table tbody tr')).toHaveCount(2);
  await expect(page.locator('.md pre code')).toContainText('await api.get()');
  await expect(page.locator('.file-link', { hasText: 'src/api.js:42' })).toBeVisible();
  await expect(page.locator('.file-ref', { hasText: 'missing.js:8' })).not.toHaveClass(/file-link/);
  expect(await page.evaluate(() => window.untrusted)).toBeUndefined();
  await page.locator('.file-link', { hasText: 'src/api.js:42' }).click();
  expect(await chat.received('openFile')).toEqual([{ type: 'openFile', path: 'src/api.js', line: 42 }]);
  await page.getByRole('link', { name: 'Reference' }).click();
  expect(await chat.received('openExternal')).toEqual([{ type: 'openExternal', url: 'https://example.com/docs' }]);
});

test('keyboard composer, multiline input and cancellation', async ({ page, chat }) => {
  const input = page.locator('#input');
  await input.fill('Explain');
  await input.press('Shift+Enter');
  await input.press('End');
  await input.press('x');
  await expect(input).toHaveValue('Explain\nx');
  await input.press('Enter');
  expect(await chat.received('prompt')).toEqual([{ type: 'prompt', text: 'Explain\nx', images: [] }]);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await input.press('Escape');
  expect(await chat.received('cancel')).toHaveLength(1);
  await chat.send({ type: 'turnEnd', stopReason: 'cancelled' });
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await expect(input).toBeEnabled();
});

test('plan and tools remain inspectable after completion', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Inspect the API.' } });
  await chat.update({ sessionUpdate: 'plan', entries: [
    { content: 'Inspect entry points', status: 'completed', priority: 'high' },
    { content: 'Review error handling', status: 'in_progress', priority: 'medium' },
  ] });
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', title: 'Read API', status: 'in_progress', rawInput: { path: 'src/api.js' } });
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'function request() {\n  return client.get();\n}' } }] });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The API delegates to the client.' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('.assistant')).toContainText('delegates to the client');
  await page.locator('details.turn-steps > summary').click();
  await page.locator('details.plan > summary').click();
  await expect(page.locator('.plan-entry.completed')).toContainText('Inspect entry points');
  await page.locator('details.tool-group > summary').click();
  // Individual calls may also be folded; expand through the real browser controls.
  for (const summary of await page.locator('details.tool-group details:not([open]) > summary').all()) await summary.click();
  await expect(page.locator('.tool-group')).toContainText('return client.get()');
});

test('question form round-trip and single-use permission response', async ({ page, chat }) => {
  await chat.send({ type: 'elicitation', requestId: 'question-1', message: 'Choose the presentation.', requestedSchema: {
    type: 'object', required: ['view'], properties: { view: { type: 'string', title: 'View', oneOf: [
      { const: 'diagram', title: 'Diagram', description: 'Show relationships visually.' },
      { const: 'table', title: 'Table', description: 'Compare the options.' },
    ] } },
  } });
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  expect(await chat.received('elicitationResponse')).toHaveLength(0);
  await page.getByRole('radio').first().check();
  await chat.snapshot('question');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  expect(await chat.received('elicitationResponse')).toEqual([{ type: 'elicitationResponse', requestId: 'question-1', action: 'accept', content: { view: 'diagram' } }]);
  await chat.send({ type: 'permission', requestId: 'permission-1', toolCall: { title: 'Read workspace' }, options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ] });
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  expect(await chat.received('permissionResponse')).toEqual([{ type: 'permissionResponse', requestId: 'permission-1', optionId: 'once' }]);
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
});

test('composer stays in the viewport while transcript scrolls', async ({ page, chat }) => {
  for (let index = 0; index < 12; index += 1) {
    await chat.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `Question ${index + 1}` } });
    await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `### Answer ${index + 1}\n\nA useful explanation with enough detail to span several lines in a narrow editor panel.\n\n- First observation\n- Second observation` } });
    await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  }
  const bounds = await page.locator('#input').boundingBox();
  expect(bounds.y).toBeGreaterThan(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('#messages').evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 0; });
  await expect(page.getByRole('heading', { name: 'Answer 1', exact: true })).toBeInViewport();
  await expect(page.locator('#input')).toBeInViewport();
  await chat.snapshot('scrolled-up');
  await chat.send({ type: 'focus' });
  await expect(page.getByRole('heading', { name: 'Answer 12', exact: true })).toBeInViewport();
});

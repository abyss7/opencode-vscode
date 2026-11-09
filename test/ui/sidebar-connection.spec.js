'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('./fixture');

test('connection failure has one compact recovery view and restores the sidebar', async ({ page, chat }) => {
  await page.setViewportSize({ width: 280, height: 600 });
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test')
    .replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scrollUri}}', 'https://opencode.test/media/scroll.js')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js')
    .replace('<title>', '<link rel="stylesheet" href="/theme.css"><title>');
  await page.route('https://opencode.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://opencode.test/');
  const error = `spawn opencode ENOENT ${'very-long-path/'.repeat(40)} <script>alert(1)</script>`;
  await chat.send({ type: 'sessions', items: [{ kind: 'error', id: 'error', name: error, children: [] }] });
  await expect(page.getByRole('heading', { name: 'OpenCode was not found' })).toBeVisible();
  await expect(page.locator('#sessions-scroll')).toBeHidden();
  await expect(page.locator('.defaults-footer')).toBeHidden();
  await expect(page.locator('#connection-details')).toBeHidden();
  await page.getByRole('link', { name: 'Download OpenCode' }).click();
  await page.getByRole('button', { name: 'Retry connection' }).click();
  expect((await chat.received('sidebarAction')).map(message => message.action)).toEqual(['downloadOpenCode', 'retryConnection']);
  await page.getByText('Technical details', { exact: true }).click();
  await expect(page.locator('#connection-details')).toHaveText(error);
  await expect(page.locator('#connection-error script')).toHaveCount(0);
  expect(await page.locator('#connection-error').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await chat.send({ type: 'sessions', items: [] });
  await chat.send({ type: 'sessionDefaults', agents: [{ id: 'build', name: 'Build' }], selected: 'build' });
  await expect(page.locator('#connection-error')).toBeHidden();
  await expect(page.locator('#sessions-empty')).toBeVisible();
  await expect(page.getByLabel('Agent for new sessions')).toBeEnabled();
  await chat.send({ type: 'connectionError', error: 'Connection refused' });
  await expect(page.getByRole('heading', { name: 'OpenCode is unavailable' })).toBeVisible();
  await expect(page.locator('.defaults-footer')).toBeHidden();
});

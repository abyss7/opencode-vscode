'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('./fixture');
const { watchRootScroll, expectInside } = require('./root-scroll');

test('queued sessions show a static clock and their queue label', async ({ page, chat }) => {
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test').replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scrollUri}}', 'https://opencode.test/media/scroll.js')
    .replaceAll('{{timeUri}}', 'https://opencode.test/media/time.js')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js');
  await page.route('https://opencode.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://opencode.test/');
  await chat.send({ type: 'sessions', items: [{ kind: 'session', id: 'queued', name: 'Waiting task',
    description: 'queued', icon: 'clock', children: [], actions: ['openSession'] }] });
  await expect(page.locator('.tree-description')).toHaveText('queued');
  const clock = page.locator('.tree-row > svg');
  await expect(clock.locator('path')).toHaveCount(2);
  expect(await clock.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('session keyboard navigation and refresh keep the defaults footer fixed', async ({ page, chat }) => {
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test')
    .replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scrollUri}}', 'https://opencode.test/media/scroll.js')
    .replaceAll('{{timeUri}}', 'https://opencode.test/media/time.js')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js')
    .replace('<title>', '<link rel="stylesheet" href="/theme.css"><title>');
  await page.route('https://opencode.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://opencode.test/');
  const items = Array.from({ length: 100 }, (_, i) => ({ kind: 'session', id: `s${i}`, name: `Session ${i}`,
    description: 'Ready', icon: 'comment-discussion', children: [], actions: ['openSession'] }));
  await chat.send({ type: 'sessions', items });
  const stable = await watchRootScroll(page, '.defaults-footer');
  const first = page.locator('.tree-node').first();
  const last = page.locator('.tree-node').last();
  await first.press('End');
  await stable();
  await expect(last).toBeFocused();
  await expectInside(last.locator('.tree-row'), page.locator('#sessions-scroll'));
  await chat.send({ type: 'sessions', items });
  await stable();
  await expect(last).toBeFocused();
  await last.press('Home');
  await stable();
  await expect(first).toBeFocused();
  await expectInside(first.locator('.tree-row'), page.locator('#sessions-scroll'));
});

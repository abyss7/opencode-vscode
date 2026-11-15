'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('./fixture');
const { watchRootScroll, expectInside } = require('./root-scroll');

const session = (id, children = []) => ({ kind: 'session', id, name: id, children, actions: ['openSession'] });
const row = (page, id) => page.locator(`[data-key="session:${id}"]`);

test.beforeEach(async ({ page, chat }) => {
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test').replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scrollUri}}', 'https://opencode.test/media/scroll.js')
    .replaceAll('{{timeUri}}', 'https://opencode.test/media/time.js')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js');
  await page.route('https://opencode.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://opencode.test/');
});

test('tab activation reveals a nested session without taking keyboard focus or opening another tab', async ({ page, chat }) => {
  const items = [{ kind: 'folder', id: 'work', name: 'Work', children: [session('parent', [session('child')])] }];
  await chat.send({ type: 'sessions', items, activeSessionId: 'parent' });
  const folder = page.locator('[data-key="folder:work"]');
  await folder.locator(':scope > .tree-row > .twisty').click();
  await expect(row(page, 'parent')).toHaveCount(0);
  await chat.send({ type: 'sessionDefaults', selected: 'build', agents: [{ id: 'build', name: 'Build' }] });
  await page.locator('#default-agent').focus();
  await expect(page.locator('#default-agent')).toBeFocused();
  const stable = await watchRootScroll(page, '.defaults-footer');
  await chat.send({ type: 'activeSession', sessionId: 'child' });
  await expect(row(page, 'child')).toHaveAttribute('aria-selected', 'true');
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'parent')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#default-agent')).toBeFocused();
  await expectInside(row(page, 'child').locator('.tree-row'), page.locator('#sessions-scroll'));
  await stable();
  expect(await page.evaluate(() => hostMessages.filter(message => message.action === 'openSession'))).toEqual([]);
  await row(page, 'parent').locator(':scope > .tree-row > .tree-label').click();
  expect(await page.evaluate(() => hostMessages.filter(message => message.action === 'openSession').map(message => message.sidebarId)))
    .toEqual(['parent']);
  await chat.send({ type: 'activeSession', sessionId: 'parent' });
  await expect(row(page, 'parent')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'child')).toHaveAttribute('aria-selected', 'false');
});

test('activation waits for session data and survives webview recreation', async ({ page, chat }) => {
  await chat.send({ type: 'activeSession', sessionId: 'late' });
  await chat.send({ type: 'sessions', items: [session('other')], activeSessionId: 'late' });
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0);
  const items = [session('other'), session('parent', [session('late')])];
  await chat.send({ type: 'sessions', items, activeSessionId: 'late' });
  await expect(row(page, 'late')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await chat.send({ type: 'sessions', items, activeSessionId: 'other' });
  await expect(row(page, 'other')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'late')).toHaveAttribute('aria-selected', 'false');
  await chat.send({ type: 'activeSession', sessionId: null });
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0);
});

test('tab switching scrolls only once and refresh preserves manual tree navigation', async ({ page, chat }) => {
  const items = Array.from({ length: 100 }, (_, i) => session(`s${i}`));
  await chat.send({ type: 'sessions', items, activeSessionId: 's0' });
  const stable = await watchRootScroll(page, '.defaults-footer');
  await chat.send({ type: 'activeSession', sessionId: 's99' });
  await expect(row(page, 's99')).toHaveAttribute('aria-selected', 'true');
  await expectInside(row(page, 's99').locator('.tree-row'), page.locator('#sessions-scroll'));
  await row(page, 's99').press('Home');
  await expect(row(page, 's0')).toBeFocused();
  await chat.send({ type: 'sessions', items, activeSessionId: 's99' });
  await chat.send({ type: 'activeSession', sessionId: 's99' });
  await expect(row(page, 's0')).toBeFocused();
  await expect(row(page, 's0')).toHaveAttribute('aria-selected', 'true');
  await expectInside(row(page, 's0').locator('.tree-row'), page.locator('#sessions-scroll'));
  await stable();
});

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('./fixture');

async function openSidebar(page) {
  const html = (await fs.readFile(path.join(__dirname, '../../media/sessions-sidebar.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test')
    .replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/sessions-sidebar.css')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/sessions-sidebar.js')
    .replace('<title>', '<link rel="stylesheet" href="/theme.css"><title>');
  await page.route('https://opencode.test/', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://opencode.test/');
}

const session = (id, name, children = []) => ({ kind: 'session', id, name, description: 'just now',
  icon: 'comment-discussion', actions: ['openSession', 'renameSession', 'moveSessionTo', 'archiveSession', 'deleteSession'], children });
const folder = (id, name, children = []) => ({ kind: 'folder', id, name, description: String(children.length),
  icon: 'folder', custom: true, actions: ['deleteFolder'], children });

test('agent card is pinned to the bottom of the same Sessions view', async ({ page, chat }) => {
  await openSidebar(page);
  const agents = [{ id: 'build', name: 'Build', description: 'Implementation' }, { id: 'plan', name: 'Plan', description: 'Planning' }];
  await chat.send({ type: 'sessionDefaults', agents, selected: 'build' });
  await chat.send({ type: 'sessions', items: [folder('work', 'Work', [session('ses_one', 'A short session list')])] });
  const footerBefore = await page.locator('.defaults-footer').boundingBox();
  expect(footerBefore.y + footerBefore.height).toBeCloseTo(page.viewportSize().height, 0);
  const select = page.getByLabel('Agent for new sessions');
  await expect(select).toHaveValue('build');
  await expect(select.locator('option:checked')).toHaveText('Build');
  await select.focus();
  await expect(select).toBeFocused();
  await select.selectOption('plan');
  expect(await chat.received('selectAgent')).toEqual([{ type: 'selectAgent', agent: 'plan' }]);
  await expect(select).toBeDisabled();
  await chat.send({ type: 'sessionDefaults', agents, selected: 'plan' });
  await expect(select).toBeEnabled();
  await expect(page.locator('.defaults-card')).toContainText('Existing sessions keep their agent.');
  await expect(page.locator('#defaults-error')).toBeHidden();
  const card = await page.locator('.defaults-card').boundingBox();
  expect(card.width).toBeLessThanOrEqual(page.viewportSize().width);
  await chat.send({ type: 'sessions', items: [folder('work', 'Work',
    Array.from({ length: 100 }, (_, i) => session(`ses_${i}`, `Session ${i}`)))] });
  await page.locator('#sessions-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const footerAfter = await page.locator('.defaults-footer').boundingBox();
  expect(footerAfter.y).toBeCloseTo(footerBefore.y, 0);
  await expect(select).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(page.viewportSize().height);
});

test('sessions retain nested navigation, actions, context metadata and expansion on refresh', async ({ page, chat }) => {
  await openSidebar(page);
  const items = [folder('work', 'Work', [session('ses_parent', 'Parent', [session('ses_child', '<script>Review</script>')])]),
    folder('archive', 'Archived')];
  await chat.send({ type: 'sessions', items });
  const root = page.locator('[data-key="folder:work"]');
  await root.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-key="session:ses_parent"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-key="session:ses_child"]')).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await chat.received('sidebarAction')).at(-1)).toMatchObject({ action: 'openSession', sidebarId: 'ses_child' });
  await expect(page.locator('#sessions-tree script')).toHaveCount(0);
  const context = await page.locator('[data-key="session:ses_parent"]').getAttribute('data-vscode-context');
  expect(JSON.parse(context)).toMatchObject({ sidebarId: 'ses_parent', sidebarKind: 'session', webviewSection: 'sessions' });
  await page.getByRole('button', { name: 'Actions for Parent', exact: true }).click();
  expect((await chat.received('sidebarAction')).at(-1)).toMatchObject({ action: 'menu', sidebarId: 'ses_parent' });
  await page.getByRole('button', { name: 'Collapse Work', exact: true }).click();
  await chat.send({ type: 'sessions', items });
  await expect(root).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-key="session:ses_parent"]')).toHaveCount(0);
});

test('sessions can still be dragged into folders without moving the footer', async ({ page, chat }) => {
  await openSidebar(page);
  await chat.send({ type: 'sessions', items: [folder('work', 'Work', [session('ses_parent', 'Parent')]), folder('target', 'Target')] });
  await page.locator('[data-key="session:ses_parent"] > .tree-row').dragTo(page.locator('[data-key="folder:target"] > .tree-row'));
  expect((await chat.received('sidebarAction')).at(-1)).toMatchObject({ action: 'drop', sidebarId: 'ses_parent', folderId: 'target' });
});

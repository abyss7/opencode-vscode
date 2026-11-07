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

for (const [locale, timezoneId, expected] of [
  ['en-US', 'America/Los_Angeles', '10/29/2020'],
  ['de-DE', 'Europe/Berlin', '30.10.2020'],
]) {
  test.describe(`sidebar dates in ${locale}`, () => {
    test.use({ locale, timezoneId });
    test('formats timestamps in the window locale and timezone', async ({ page, chat }) => {
      await openSidebar(page);
      await chat.send({ type: 'sessions', items: [
        { ...session('dated', 'Old session'), timestamp: Date.parse('2020-10-30T00:30:00Z'), description: '' },
        { ...session('busy', 'Busy session'), description: 'working' },
        { ...session('unknown', 'Unknown session'), description: 'execution unconfirmed' },
      ] });
      await expect(page.locator('[data-key="session:dated"] .tree-description')).toHaveText(expected);
      await expect(page.locator('[data-key="session:dated"]')).toHaveAttribute('aria-label', `Old session, ${expected}`);
      await expect(page.locator('[data-key="session:busy"] .tree-description')).toHaveText('working');
      await expect(page.locator('[data-key="session:unknown"] .tree-description')).toHaveText('execution unconfirmed');
    });
  });
}

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
  await page.locator('[data-key="session:ses_parent"] > .tree-row').hover();
  await page.getByRole('button', { name: 'Archive: Parent', exact: true }).click();
  expect((await chat.received('sidebarAction')).at(-1)).toMatchObject({ action: 'archiveSession', sidebarId: 'ses_parent' });
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

const actionRow = (page, id) => page.locator(`[data-key="session:${id}"] > .tree-row`);

async function openActionSidebar(page, chat) {
  await openSidebar(page);
  const item = (id, actions, children = []) => ({
    ...session(id, 'Long session title '.repeat(16), children), description: '14 h ago', actions,
  });
  await chat.send({ type: 'sessions', items: [folder('work', 'Work', [
    item('active', ['openSession', 'archiveSession', 'deleteSession'],
      [item('nested', ['openSession', 'deleteSession'])]),
    item('archived', ['openSession', 'restoreSession', 'deleteSession']),
    item('child', ['openSession', 'deleteSession']),
  ])] });
}

test('hover actions replace the status and take no idle space', async ({ page, chat }) => {
  await openActionSidebar(page, chat);
  const active = actionRow(page, 'active');
  const archive = active.locator('[data-action="archiveSession"]');
  const status = active.locator('.tree-description');
  const label = active.locator('.tree-label');
  await expect(archive).toBeHidden();
  await expect(status).toBeVisible();
  const resting = await active.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    status: element.querySelector('.tree-description').getBoundingClientRect().right,
    label: element.querySelector('.tree-label').getBoundingClientRect().width,
    padding: parseFloat(getComputedStyle(element).paddingRight),
  }));
  expect(resting.right - resting.status).toBeCloseTo(resting.padding);
  await active.hover();
  await expect(archive).toBeVisible();
  await expect(active.locator('[data-action="deleteSession"]')).toBeVisible();
  await expect(status).toBeHidden();
  expect(await label.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(resting.label);
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.locator('.defaults-footer').hover();
  await expect(archive).toBeHidden();
  await expect(status).toBeVisible();
  expect(await status.evaluate((element) => element.getBoundingClientRect().right)).toBe(resting.status);
  const folder = page.locator('[data-key="folder:work"] > .tree-row');
  await folder.hover();
  await expect(folder.locator('.tree-description')).toBeVisible();
});

test('archive, restore and delete target their session without opening it', async ({ page, chat }) => {
  await openActionSidebar(page, chat);
  for (const [id, action] of [['active', 'archiveSession'], ['archived', 'restoreSession'], ['child', 'deleteSession']]) {
    await actionRow(page, id).hover();
    await actionRow(page, id).locator(`[data-action="${action}"]`).click();
  }
  expect(await chat.received('sidebarAction')).toEqual([
    { type: 'sidebarAction', action: 'archiveSession', sidebarKind: 'session', sidebarId: 'active' },
    { type: 'sidebarAction', action: 'restoreSession', sidebarKind: 'session', sidebarId: 'archived' },
    { type: 'sidebarAction', action: 'deleteSession', sidebarKind: 'session', sidebarId: 'child' },
  ]);
  await expect(actionRow(page, 'child').locator('.tree-action')).toHaveCount(1);
});

test('keyboard activation invokes the focused action rather than opening the session', async ({ page, chat }) => {
  await openActionSidebar(page, chat);
  await page.locator('#sessions-tree > .tree-node').focus();
  await page.keyboard.press('ArrowDown');
  const archive = actionRow(page, 'active').locator('[data-action="archiveSession"]');
  await expect(archive).toBeVisible();
  // A focused nested row must not reveal its parent's actions.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-key="session:nested"]')).toBeFocused();
  await expect(archive).toBeHidden();
  await expect(actionRow(page, 'nested').locator('[data-action="deleteSession"]')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(archive).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(archive).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await chat.received('sidebarAction')).toEqual([
    { type: 'sidebarAction', action: 'archiveSession', sidebarKind: 'session', sidebarId: 'active' },
  ]);
});

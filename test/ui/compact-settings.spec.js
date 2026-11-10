'use strict';

const { test, expect } = require('./fixture');

const config = (effort = 'high') => ({ type: 'config', configOptions: [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openai/sol', options: [
    { value: 'openai/sol', name: 'openai/GPT-6.1 Sol' },
    { value: 'anthropic/other', name: 'anthropic/Other model' },
  ] },
  { id: 'effort', name: 'Effort', type: 'select', currentValue: effort, options: [
    { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'default', name: 'Default' },
  ] },
] });
const policy = (changes = {}) => ({ type: 'permissionProfile', selected: 'workspace', newActions: 'smart', profiles: [
  { id: 'workspace', label: 'Workspace' }, { id: 'all', label: 'All ⚠' },
  { id: 'host', label: 'Host' },
], ...changes });

async function insideViewport(page, locator) {
  const box = await locator.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
}

test('two compact summaries disclose one menu at a time and preserve effort after saving', async ({ page, chat }) => {
  await chat.send(config(), policy());
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  const permissions = page.getByRole('button', { name: 'Permissions', exact: true });
  const effort = page.getByRole('slider', { name: 'Effort' });
  await expect(model).toHaveText('GPT-6.1 Sol·High');
  await expect(permissions).toHaveText('Workspace·Smart');
  await expect(effort).toBeHidden();
  await expect(page.getByLabel('Profile', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open permission rules' })).toBeHidden();
  const agent = await page.locator('#agent-label').boundingBox();
  const input = await page.locator('#input').boundingBox();
  const toolbar = await page.locator('#config-bar').boundingBox();
  expect(agent.y + agent.height).toBeLessThanOrEqual(input.y);
  expect(input.y + input.height).toBeLessThanOrEqual(toolbar.y);
  await model.click();
  await expect(effort).toBeVisible();
  await insideViewport(page, page.getByRole('dialog', { name: 'Model settings' }));
  await permissions.click();
  await expect(effort).toBeHidden();
  await expect(page.getByLabel('Profile', { exact: true })).toBeVisible();
  await permissions.press('Escape');
  await expect(permissions).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Permissions settings' })).toBeHidden();
  await model.click();
  await effort.press('Home');
  expect(await chat.received('setConfigOption')).toEqual([{ type: 'setConfigOption', configId: 'effort', value: 'default' }]);
  await chat.send(config('default'));
  await expect(effort).toBeFocused();
  await expect(effort).toHaveAttribute('aria-valuetext', 'Default');
  await expect(model).toHaveText('GPT-6.1 Sol·Default');
  await effort.press('Escape');
  await expect(model).toBeFocused();
  await expect(effort).toBeHidden();
  await chat.snapshot('compact-settings');
});

test('search filters models, handles no matches and keyboard selection without changing effort implicitly', async ({ page, chat }) => {
  await chat.send(config(), policy());
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await model.click();
  await page.keyboard.press('Tab');
  const search = page.getByRole('searchbox', { name: 'Search models' });
  await expect(search).toBeFocused();
  await search.fill('not a model');
  await expect(page.getByText('No matching models', { exact: true })).toBeVisible();
  await search.press('Enter');
  expect(await chat.received('setConfigOption')).toEqual([]);
  await search.fill('anthropic');
  const list = page.getByRole('listbox', { name: 'Models' });
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option')).toHaveText('Other model');
  await search.press('Enter');
  expect(await chat.received('setConfigOption')).toEqual([{ type: 'setConfigOption', configId: 'model', value: 'anthropic/other' }]);
  await expect(model).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Model settings' })).toBeHidden();
});

test('permission summary stays neutral with broad-access warning inside the menu', async ({ page, chat }) => {
  await chat.send(config(), policy({ selected: 'all', newActions: 'permit', fallbackLocked: true, inherited: true }));
  const button = page.getByRole('button', { name: 'Permissions', exact: true });
  await expect(button).not.toHaveClass(/permission-warning/);
  await expect(button).toHaveText('All·Permit');
  await expect(button).not.toContainText('⚠');
  const warning = page.locator('.permission-access-warning');
  await expect(warning).toBeHidden();
  await button.press('ArrowDown');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Broad access');
  await expect(page.getByRole('button', { name: 'Open permission rules' })).toBeFocused();
  await expect(page.getByLabel('Profile', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Without a rule', { exact: true })).toBeDisabled();
  await expect(page.getByText('Inherited from parent', { exact: true })).toBeVisible();
  await insideViewport(page, page.getByRole('dialog', { name: 'Permissions settings' }));
  await page.keyboard.press('Enter');
  expect(await chat.received('openPermissionRules')).toEqual([{ type: 'openPermissionRules' }]);
  await expect(button).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Permissions settings' })).toBeHidden();
  await chat.send(policy());
  await expect(button).not.toHaveClass(/permission-warning/);
  await expect(warning).toHaveCount(0);
});

for (const [name, changes, explanation] of [
  ['Host', { selected: 'host', newActions: 'permit', fallbackLocked: true }, 'Broad access'],
  ['Permit fallback', { newActions: 'permit' }, 'actions without a matching rule'],
]) {
  test(`${name} only warns within the open permissions menu`, async ({ page, chat }) => {
    await chat.send(config(), policy(changes));
    const button = page.getByRole('button', { name: 'Permissions', exact: true });
    const warning = page.locator('.permission-access-warning');
    await expect(button).not.toHaveClass(/permission-warning/);
    await expect(button).not.toContainText('⚠');
    await expect(warning).toBeHidden();
    await button.click();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(explanation);
    await page.keyboard.press('Escape');
    await expect(warning).toBeHidden();
    await expect(button).toBeFocused();
  });
}

test('permission saves and rejected changes restore keyboard focus in the open menu', async ({ page, chat }) => {
  await chat.send(config(), policy());
  const button = page.getByRole('button', { name: 'Permissions', exact: true });
  await button.press('ArrowDown');
  const profile = page.getByLabel('Profile', { exact: true });
  await expect(profile).toBeFocused();
  await profile.selectOption('all');
  await expect(profile).toBeDisabled();
  await chat.send(policy({ selected: 'all', newActions: 'permit', fallbackLocked: true }));
  await expect(profile).toBeEnabled();
  await expect(profile).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await profile.selectOption('workspace');
  await chat.send(policy());
  const fallback = page.getByLabel('Without a rule', { exact: true });
  await fallback.focus();
  await fallback.selectOption('forbid');
  await chat.send({ type: 'error', message: 'Selection rejected' }, policy());
  await expect(fallback).toBeEnabled();
  await expect(fallback).toBeFocused();
  await expect(fallback).toHaveValue('smart');
  await expect(button).toHaveText('Workspace·Smart');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('menus stay within a short viewport and dismiss outside without moving the document', async ({ page, chat }) => {
  await page.setViewportSize({ width: page.viewportSize().width, height: 420 });
  await chat.send(config(), policy());
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await model.click();
  await insideViewport(page, page.getByRole('dialog', { name: 'Model settings' }));
  await expect(page.getByRole('slider', { name: 'Effort' })).toBeInViewport();
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await insideViewport(page, page.getByRole('dialog', { name: 'Permissions settings' }));
  await page.mouse.click(2, 2);
  await expect(page.getByRole('dialog', { name: 'Permissions settings' })).toBeHidden();
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0]);
});

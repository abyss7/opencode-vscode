'use strict';

const { test, expect } = require('./fixture');
const { SessionClient } = require('../../src/session-client');

test('server default and Effort slider survive changes and reopening', async ({ page, chat }) => {
  let session = {};
  const models = [
    { providerID: 'openai', id: 'first', name: 'First', type: 'chat', variants: [] },
    { providerID: 'openai', id: 'preferred', name: 'Preferred', type: 'chat', variants: [{ id: 'low' }, { id: 'high' }] },
    { providerID: 'opencode', id: 'preferred', name: 'Preferred', type: 'chat', variants: [] },
  ];
  const client = new SessionClient({ cwd: '/work', api: {
    getSession: async () => session,
    listModels: async () => models,
    listAgents: async () => [{ id: 'build', name: 'Build' }],
    getDefaultModel: async () => models[1],
    _request: async (_method, _path, body) => { session = { model: body.model }; },
  } });
  client.sessionId = 'ses_test';
  const refresh = async () => {
    await client.refreshConfig();
    await chat.send({ type: 'config', configOptions: client.configOptions });
  };
  const apply = async () => {
    const message = (await chat.received('setConfigOption')).at(-1);
    await client.setConfigOption(message.configId, message.value);
    await refresh();
  };
  await refresh();
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  const effort = page.getByRole('slider', { name: 'Effort', exact: true });
  await expect(model.locator('.model-name')).toHaveText('Preferred');
  await expect(model).toHaveAttribute('title', 'openai: Preferred');
  await expect(model.locator('svg.model-provider-icon')).toHaveAttribute('data-provider', 'openai');
  await expect.poll(() => model.locator('.model-provider-icon').evaluate((svg) => svg.getBBox().width)).toBeGreaterThan(0);
  await model.click();
  const list = page.getByRole('listbox', { name: 'Models' });
  await expect(list.getByRole('group', { name: 'All models' }).locator('.model-name')).toHaveText(['First', 'Preferred', 'Preferred']);
  await expect(list.getByRole('option', { name: 'opencode: Preferred', exact: true }).locator('svg.model-provider-icon'))
    .toHaveAttribute('data-provider', 'opencode');
  await model.press('Escape');
  await expect(effort).toBeHidden();
  await model.click();
  await expect(effort).toHaveAttribute('aria-valuetext', 'Default');
  await expect(page.locator('.effort-ticks > span')).toHaveCount(3);
  await effort.press('End');
  await expect(effort).toBeDisabled();
  await apply();
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveAttribute('aria-valuetext', 'High');
  await expect(effort).toBeFocused();
  expect(session.model).toEqual({ providerID: 'openai', id: 'preferred', variant: 'high' });
  await page.reload();
  await refresh();
  await expect(model).toHaveAttribute('title', 'openai: Preferred');
  await model.click();
  await expect(effort).toHaveAttribute('aria-valuetext', 'High');
  await effort.press('Home');
  await apply();
  expect(session.model).toEqual({ providerID: 'openai', id: 'preferred' });
  await model.press('Escape');
  await model.click();
  await list.getByRole('option', { name: 'opencode: Preferred', exact: true }).click();
  await expect(model).toBeDisabled();
  await apply();
  await expect(model).toBeEnabled();
  await expect(model).toBeFocused();
  await expect(model).toHaveAttribute('title', 'opencode: Preferred');
  await expect(model.locator('.model-name')).toHaveText('Preferred');
  await expect(model.locator('svg.model-provider-icon')).toHaveAttribute('data-provider', 'opencode');
  expect(session.model).toEqual({ providerID: 'opencode', id: 'preferred' });
  await expect(effort).toHaveCount(0);
});

const catalog = (options, currentValue = options[0]?.value) => ({ type: 'config', configOptions: [
  { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue, options },
  { id: 'effort', name: 'Effort', type: 'select', currentValue: 'default', options: [
    { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'default', name: 'Default' },
  ] },
] });

test('model picker supports keyboard selection, typeahead, dismissal and failed-save recovery', async ({ page, chat }) => {
  const message = catalog([
    { value: 'openai/a', name: 'openai/Alpha' },
    { value: 'opencode/a', name: 'opencode/Alpha' },
    { value: 'deepseek/b', name: 'deepseek/Beta' },
  ]);
  await chat.send(message);
  const button = page.getByRole('combobox', { name: 'Model', exact: true });
  const list = page.getByRole('listbox', { name: 'Models' });
  await button.focus();
  await button.press('ArrowDown');
  await button.press('ArrowDown');
  await expect(button).toHaveAttribute('aria-activedescendant', /-1$/);
  await button.press('Escape');
  await expect(list).toBeHidden();
  expect(await chat.received('setConfigOption')).toHaveLength(0);
  await button.press('End');
  await expect(button).toHaveAttribute('aria-activedescendant', /-3$/);
  await button.press('Home');
  await expect(button).toHaveAttribute('aria-activedescendant', /-0$/);
  await button.press('b');
  await expect(button).toHaveAttribute('aria-activedescendant', /-3$/);
  await button.press('Enter');
  expect(await chat.received('setConfigOption')).toEqual([{ type: 'setConfigOption', configId: 'model', value: 'deepseek/b' }]);
  await button.press('Enter');
  expect(await chat.received('setConfigOption')).toHaveLength(1);
  await chat.send({ type: 'error', message: 'Selection rejected' }, message);
  await expect(button).toBeFocused();
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('title', 'openai: Alpha');
  await button.click();
  // The dropup can cover the input on narrow panels; click outside its bounds.
  await page.mouse.click(2, 2);
  await expect(list).toBeHidden();
  await button.focus();
  await button.press(' ');
  await button.press('Tab');
  await expect(list).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search models' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('slider', { name: 'Effort', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list).toBeHidden();
});

test('long catalogs stay in the viewport and unknown providers have safe fallback badges', async ({ page, chat }) => {
  const options = Array.from({ length: 100 }, (_, i) => ({ value: `openai/model-${i}`, name: `openai/Model ${i}` }));
  options.push({ value: 'custom-host/model', name: 'custom-host/<img src=x onerror=alert(1)> A very long model name with a slash / inside' });
  await chat.send(catalog(options));
  const button = page.getByRole('combobox', { name: 'Model', exact: true });
  await button.press('End');
  const list = page.getByRole('listbox', { name: 'Models' });
  const last = list.getByRole('group', { name: 'All models' }).getByRole('option').last();
  await expect(last.locator('.model-provider-fallback')).toHaveText('CH');
  await expect(last.locator('img')).toHaveCount(0);
  await expect(last).toBeInViewport();
  const box = await list.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
  await button.press('Enter');
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('custom-host/model');
  await chat.send(catalog(options, 'custom-host/model'));
  await expect(button.locator('.model-provider-fallback')).toHaveText('CH');
  await expect(button.locator('.model-name')).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize().width);
  await button.click();
  await chat.send(catalog(options, 'openai/model-1'));
  await expect(page.locator('.model-picker-list')).toHaveCount(1);
  await expect(page.getByRole('listbox', { name: 'Models' })).toBeHidden();
  await expect(button).toBeFocused();
});

test('bundled provider logos load offline and follow the active theme color', async ({ page, chat }) => {
  const providers = ['openai', 'opencode', 'deepseek', 'anthropic', 'google', 'xai', 'mistral', 'groq', 'openrouter', 'azure'];
  await chat.send(catalog(providers.map((id) => ({ value: `${id}/chat`, name: `${id}/Chat` }))));
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  const icons = page.getByRole('group', { name: 'All models' }).locator('svg');
  await expect(icons).toHaveCount(providers.length);
  await expect.poll(() => icons.evaluateAll((nodes) => nodes.every((svg) => svg.getBBox().width > 0))).toBe(true);
  await page.locator('.model-picker-list').evaluate((node) => { node.style.color = 'rgb(123, 45, 67)'; });
  await expect(icons.last()).toHaveCSS('color', 'rgb(123, 45, 67)');
  await chat.snapshot('provider-icons');
});

test('Recent pins the current model above three unique available models without shrinking the catalog', async ({ page, chat }) => {
  const options = Array.from({ length: 6 }, (_, i) => ({ value: `openai/model-${i}`, name: `openai/Model ${i}` }));
  const message = catalog(options, 'openai/model-4');
  message.configOptions[0].recentValues = ['missing/model', 'openai/model-2', 'openai/model-4', 'openai/model-2',
    'openai/model-1', 'openai/model-3', 'openai/model-0'];
  await chat.send(message);
  const button = page.getByRole('combobox', { name: 'Model', exact: true });
  await button.click();
  const recent = page.getByRole('group', { name: 'Recent', exact: true });
  const all = page.getByRole('group', { name: 'All models', exact: true });
  await expect(recent.locator('.model-name')).toHaveText(['Model 4', 'Model 2', 'Model 1', 'Model 3']);
  await expect(all.locator('.model-name')).toHaveText(options.map((_, i) => `Model ${i}`));
  await expect(recent.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(all.getByRole('option', { name: 'openai: Model 4', exact: true })).toHaveAttribute('aria-selected', 'false');
  await button.press('ArrowDown');
  await button.press('Enter');
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('openai/model-2');
  await chat.send(message);
  await button.click();
  const search = page.getByRole('searchbox', { name: 'Search models' });
  await search.fill('model 2');
  await expect(recent).toBeHidden();
  await expect(all.getByRole('option')).toHaveCount(1);
  await search.fill('unknown');
  await expect(page.getByText('No matching models', { exact: true })).toBeVisible();
  await search.fill(' ');
  await expect(recent).toBeHidden();
  await expect(all.getByRole('option')).toHaveCount(6);
  await search.fill('');
  await expect(recent).toBeVisible();
  await expect(recent.locator('.model-name')).toHaveText(['Model 4', 'Model 2', 'Model 1', 'Model 3']);
  await search.fill('model 2');
  // Incoming host updates preserve the search and do not resurrect Recent.
  await chat.send(message);
  await expect(search).toHaveValue('model 2');
  await expect(recent).toBeHidden();
  await search.press('Enter');
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('openai/model-2');
});

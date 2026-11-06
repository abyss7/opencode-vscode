'use strict';

const { test, expect } = require('./fixture');
const { SessionClient } = require('../../src/session-client');

test('server default and separate Effort selector survive changes and reopening', async ({ page, chat }) => {
  let session = {};
  const models = [
    { providerID: 'p', id: 'first', name: 'First', type: 'chat', variants: [] },
    { providerID: 'p', id: 'preferred', name: 'Preferred', type: 'chat', variants: [{ id: 'low' }, { id: 'high' }] },
    { providerID: 'other', id: 'preferred', name: 'Preferred', type: 'chat', variants: [] },
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
  const effort = page.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(model).toHaveValue('p/preferred');
  await expect(model.locator('option')).toHaveText(['p/First', 'p/Preferred', 'other/Preferred']);
  await expect(effort).toHaveValue('default');
  await expect(effort.locator('option')).toHaveText(['Low', 'High', 'Default']);
  await effort.selectOption('high');
  await expect(effort).toBeDisabled();
  await apply();
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveValue('high');
  expect(session.model).toEqual({ providerID: 'p', id: 'preferred', variant: 'high' });
  await page.reload();
  await refresh();
  await expect(model).toHaveValue('p/preferred');
  await expect(effort).toHaveValue('high');
  await effort.selectOption('default');
  await apply();
  expect(session.model).toEqual({ providerID: 'p', id: 'preferred' });
  await model.selectOption('p/first');
  await apply();
  await expect(model).toHaveValue('p/first');
  await expect(effort.locator('option')).toHaveText(['Default']);
});

'use strict';

const { test, expect } = require('./fixture');

// VS Code serves extension resources from a different origin than the webview.
// A same-origin fixture misses Chromium's restriction on external SVG <use>.
test.use({ resourceOrigin: 'https://webview-resources.test' });

test('provider icons and a full-sized chevron render with cross-origin webview resources', async ({ page, chat }) => {
  const providers = ['openai', 'opencode', 'deepseek'];
  await chat.send({ type: 'config', configOptions: [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'deepseek/chat',
    options: providers.map((id) => ({ value: `${id}/chat`, name: `${id}/Chat` })),
  }] });
  const button = page.getByRole('combobox', { name: 'Model', exact: true });
  const icon = button.locator('.model-provider-icon');
  await expect.poll(() => icon.evaluate((svg) => svg.getBBox().width)).toBeGreaterThan(0);
  await expect(icon.locator('path')).toHaveCount(1);
  await expect(button.locator('use')).toHaveCount(0);
  const chevron = button.locator('svg.model-picker-chevron');
  await expect(chevron).toHaveAttribute('aria-hidden', 'true');
  const box = await chevron.boundingBox();
  expect(box.width).toBe(16);
  expect(box.height).toBe(16);
  expect(await chevron.evaluate((svg) => svg.getBBox().width)).toBeGreaterThanOrEqual(9);
  await button.click();
  const list = page.getByRole('listbox', { name: 'Models' });
  const icons = list.getByRole('group', { name: 'All models' }).locator('.model-provider-icon');
  await expect(icons).toHaveCount(3);
  expect(await icons.evaluateAll((nodes) => nodes.every((svg) => svg.getBBox().width > 0))).toBe(true);
  await expect(list.locator('use')).toHaveCount(0);
  await chat.snapshot('cross-origin-provider-icons');
});

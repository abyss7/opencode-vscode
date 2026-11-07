'use strict';

const { test, expect } = require('./fixture');

const config = (currentValue = 'default', levels = ['low', 'medium', 'high', 'custom']) => ({
  type: 'config', configOptions: [{ id: 'effort', name: 'Effort', type: 'select', currentValue,
    options: [...levels, 'default'].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
  }],
});

test('ticks preview on hover and drag, sending only the final level', async ({ page, chat }) => {
  await chat.send(config());
  const slider = page.getByRole('slider', { name: 'Effort' });
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeHidden();
  await expect(page.locator('.effort-control')).toHaveText('Effort', { useInnerText: true });
  const box = await slider.boundingBox();
  const point = (index) => ({ x: box.x + 6 + (box.width - 12) * index / 4, y: box.y + box.height / 2 });
  const hover = point(3);
  await page.mouse.move(hover.x, hover.y);
  await expect(tooltip).toHaveText('High');
  const tip = await tooltip.boundingBox();
  expect(tip.x).toBeGreaterThanOrEqual(0);
  expect(tip.x + tip.width).toBeLessThanOrEqual(page.viewportSize().width);
  await expect(slider).toHaveAttribute('aria-valuetext', 'Default');
  expect(await chat.received('setConfigOption')).toHaveLength(0);
  const start = point(0);
  await page.mouse.move(start.x, start.y);
  await expect(tooltip).toHaveText('Default — model setting');
  await page.mouse.down();
  await page.mouse.move(hover.x, hover.y, { steps: 8 });
  await expect(tooltip).toHaveText('High');
  await expect(slider).toHaveAttribute('aria-valuetext', 'High');
  expect(await chat.received('setConfigOption')).toHaveLength(0);
  await page.mouse.up();
  await expect(slider).toBeDisabled();
  expect(await chat.received('setConfigOption')).toEqual([{ type: 'setConfigOption', configId: 'effort', value: 'high' }]);
  await chat.send(config('high'));
  await expect(slider).toBeEnabled();
  await page.getByRole('textbox', { name: 'Ask OpenCode…' }).click();
  await expect(tooltip).toBeHidden();
  await expect(page.locator('.effort-control')).toHaveText('Effort', { useInnerText: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize().width);
  await chat.snapshot('effort-slider');
});

test('keyboard changes retain focus, recover after rejection and follow model levels', async ({ page, chat }) => {
  await chat.send(config('low'));
  const slider = page.getByRole('slider', { name: 'Effort' });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Medium');
  await slider.press('End');
  expect(await chat.received('setConfigOption')).toEqual([{ type: 'setConfigOption', configId: 'effort', value: 'medium' }]);
  await chat.send({ type: 'error', message: 'Selection rejected' }, config('low'));
  await expect(slider).toBeFocused();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
  await slider.press('End');
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('custom');
  await chat.send(config('custom'));
  await slider.press('Home');
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('default');
  await chat.send(config('default', ['none', 'high']));
  await expect(slider).toHaveAttribute('max', '2');
  await expect(page.locator('.effort-ticks > span')).toHaveCount(3);
  await slider.press('ArrowRight');
  expect((await chat.received('setConfigOption')).at(-1).value).toBe('none');
  await chat.send({ type: 'config', configOptions: [] });
  await expect(slider).toHaveCount(0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

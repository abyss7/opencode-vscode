'use strict';

const { test, expect } = require('./fixture');

test('native radio focus is round without changing keyboard selection', async ({ page, chat }) => {
  await chat.send({ type: 'elicitation', requestId: 'round-focus', message: 'Choose.', requestedSchema: {
    type: 'object', properties: { choice: { type: 'string', enum: ['Yes', 'No'] } },
  } });
  const radios = page.getByRole('radio');
  await radios.first().check();
  await expect(radios.first()).toBeFocused();
  const geometry = await radios.first().evaluate((input) => {
    const control = input.parentElement;
    const style = getComputedStyle(control);
    const native = getComputedStyle(input);
    const bounds = control.getBoundingClientRect();
    return {
      appearance: native.appearance, outline: native.outlineStyle, shadow: native.boxShadow,
      radius: style.borderRadius, ring: style.boxShadow,
      width: bounds.width, height: bounds.height,
    };
  });
  expect(geometry.appearance).toBe('auto');
  expect(geometry.outline).toBe('none');
  expect(geometry.shadow).toBe('none');
  expect(geometry.radius).toBe('50%');
  expect(geometry.width).toBe(geometry.height);
  expect(geometry.ring).not.toBe('none');
  await chat.snapshot('native-radio-round-focus');
  await page.keyboard.press('ArrowDown');
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.first().locator('..')).toHaveCSS('box-shadow', 'none');
});

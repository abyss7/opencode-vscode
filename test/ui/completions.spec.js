'use strict';

const { test, expect } = require('./fixture');

test('native command and skill prefixes stay separate', async ({ page, chat }) => {
  await chat.send({ type: 'slashItems', commands: [{ name: 'review', description: 'Review changes' }],
    skills: [{ id: 'handoff', description: 'Save notes' }] });
  const input = page.locator('#input');
  const menu = page.locator('#slash-menu');
  await input.fill('/');
  await expect(menu).toHaveAttribute('aria-label', 'Commands');
  await expect(menu.locator('.slash-name')).toHaveText(['/review']);
  await input.fill('/hand');
  await expect(menu).toBeHidden();
  await input.fill('@');
  await expect(menu).toHaveAttribute('aria-label', 'Skills');
  await expect(menu.locator('.slash-name')).toHaveText(['@handoff']);
  await input.press('Enter');
  await expect(input).toHaveValue('@handoff ');
  await expect(menu).toBeHidden();
  await input.fill('/review');
  await input.press('Tab');
  await input.press('Enter');
  expect(await chat.received('command')).toEqual([expect.objectContaining({ name: 'review', text: '' })]);
  expect(await chat.received('prompt')).toEqual([]);
  await expect(page.locator('.hint')).toContainText('/ commands · @ skills');
});

test('skill completion replaces only the active mention and preserves surrounding text', async ({ page, chat }) => {
  await chat.send({ type: 'slashItems', commands: [{ name: 'review' }],
    skills: [{ id: 'handoff', description: 'Save notes' }] });
  const input = page.locator('#input');
  const menu = page.locator('#slash-menu');
  await input.fill('Please use\n@hand later.');
  // Moving the caret into a draft token opens completion without changing the draft.
  await input.press('Home');
  await input.press('ArrowRight');
  await input.press('ArrowRight');
  await input.press('ArrowRight');
  await expect(menu.locator('.slash-name')).toHaveText(['@handoff']);
  await menu.locator('.slash-item').click();
  await expect(input).toHaveValue('Please use\n@handoff later.');
  await expect(input).toBeFocused();
  await expect(menu).toBeHidden();
  await input.fill('Please use @hand');
  await input.press('Tab');
  await expect(input).toHaveValue('Please use @handoff ');
  await input.fill('@hand');
  await input.press('Escape');
  await expect(menu).toBeHidden();
  for (const value of ['name@host', '#hand', '!review', 'Please /review', '@review']) {
    await input.fill(value);
    await expect(menu).toBeHidden();
  }
});

test('command suggestions follow server discovery without injected entries and deduplicate sources', async ({ page, chat }) => {
  const input = page.locator('#input');
  await input.fill('/comp');
  await expect(page.locator('#slash-menu')).toBeHidden();
  await chat.send({ type: 'slashItems', commands: [{ name: 'compact', description: 'Server description' }], skills: [] });
  await expect(page.locator('.slash-name')).toHaveText(['/compact']);
  await chat.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
  await expect(page.locator('.slash-name')).toHaveText(['/compact']);
});

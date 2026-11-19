'use strict';

const { test, expect } = require('./fixture');

test('composer Undo and Redo stay local and restore native edits and selection', async ({ page, chat }) => {
  const input = page.locator('#input');
  await input.pressSequentially('first line');
  await input.press('Shift+Enter');
  await input.pressSequentially('second');
  const original = 'first line\nsecond';
  await expect(input).toHaveValue(original);

  await input.press('Shift+Home');
  await page.keyboard.insertText('replacement');
  await expect(input).toHaveValue('first line\nreplacement');
  await input.press('Control+z');
  await expect(input).toHaveValue(original);
  expect(await input.evaluate((node) => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('second');
  await input.press('Control+Shift+z');
  await expect(input).toHaveValue('first line\nreplacement');
  await input.press('Control+z');
  await page.keyboard.insertText('new branch');
  await input.press('Control+y');
  await expect(input).toHaveValue('first line\nnew branch');
  expect((await chat.received('saveDraft')).at(-1).text).toBe('first line\nnew branch');
  expect(await chat.received('prompt')).toEqual([]);
});

test('completions are undoable and redoable', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'review', description: 'Review changes' }] });
  const input = page.locator('#input');
  await input.pressSequentially('/rev');
  await input.press('Tab');
  await expect(input).toHaveValue('/review ');
  await expect(page.locator('#slash-menu')).toBeHidden();
  await input.press('Control+z');
  await expect(input).toHaveValue('/rev');
  await input.press('Control+Shift+z');
  await expect(input).toHaveValue('/review ');
});

test('fresh composer restores its host draft without overwriting newer input', async ({ page, chat }) => {
  const input = page.locator('#input');
  const text = '  unsent\n\nтекст  ';
  await input.fill(text);
  const draft = (await chat.received('saveDraft')).at(-1);
  expect(draft.text).toBe(text);

  await page.reload();
  await chat.send({ type: 'restoreDraft', text: draft.text }, { type: 'status', state: 'ready' });
  await expect(input).toHaveValue(text);
  await expect(page.locator('#send')).toBeEnabled();
  expect(await chat.received('saveDraft')).toEqual([]);

  await input.fill('newer unsent text');
  await chat.send({ type: 'restoreDraft', text });
  await expect(input).toHaveValue('newer unsent text');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  const messages = await page.evaluate(() => window.hostMessages.slice(-2));
  expect(messages[0]).toMatchObject({ type: 'prompt', text: 'newer unsent text' });
  expect(messages[1]).toEqual({ type: 'saveDraft', text: '' });
});

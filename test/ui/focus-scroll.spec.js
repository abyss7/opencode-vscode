'use strict';

const { test, expect } = require('./fixture');
const { watchRootScroll, scrollTranscript, expectInside } = require('./root-scroll');

test('incoming question autofocus reveals its input inside a tall footer', async ({ page, chat }) => {
  const stable = await watchRootScroll(page, '#header');
  await chat.send({ type: 'elicitation', requestId: 'focus-question', message: 'Question context.\n\n'.repeat(60),
    requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } } });
  await stable();
  const input = page.locator('#questions input').first();
  await expect(input).toBeFocused();
  await expectInside(input, page.locator('#questions'));
  expect(await page.locator('#questions').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await stable();
  await expect(input).toBeFocused();
  await expectInside(input, page.locator('#questions'));
});

test('multiline caret scrolling and restored composer focus preserve the reading position', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await scrollTranscript(page, false);
  const stable = await watchRootScroll(page, '#header');
  const input = page.locator('#input');
  await input.fill('Draft line\n'.repeat(24));
  await input.press('Control+End');
  await stable();
  expect(await input.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  // Resizing the composer can adjust the transcript's native scroll anchor.
  // Restoring focus must preserve the resulting reading position.
  const readingTop = await page.locator('#messages').evaluate(node => node.scrollTop);
  await page.evaluate(() => { document.activeElement.blur(); window.dispatchEvent(new Event('focus')); });
  await stable();
  await expect(input).toBeFocused();
  await page.locator('#activity-jump').focus();
  await chat.send({ type: 'focus', preserveScroll: true });
  await stable();
  await expect(input).toBeFocused();
  expect(await page.locator('#messages').evaluate(node => node.scrollTop)).toBe(readingTop);
  const composer = await page.locator('#composer').boundingBox();
  expect(composer.y + composer.height).toBeCloseTo(page.viewportSize().height, 0);
});

test('slash completion restores input focus without scrolling the document', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }] });
  const stable = await watchRootScroll(page);
  await page.locator('#input').fill('/rev');
  await page.locator('.slash-item').first().click();
  await stable();
  await expect(page.locator('#input')).toBeFocused();
  await expect(page.locator('#input')).toHaveValue('/review ');
});

test('effort updates restore focus without scrolling the document', async ({ page, chat }) => {
  const option = { id: 'effort', name: 'Effort', type: 'select', currentValue: 'default',
    options: ['default', 'low', 'high'].map(value => ({ value, name: value })) };
  await chat.send({ type: 'config', configOptions: [option] });
  const stable = await watchRootScroll(page);
  const slider = page.getByRole('slider', { name: 'Effort' });
  await slider.press('End');
  await chat.send({ type: 'config', configOptions: [{ ...option, currentValue: 'high' }] });
  await stable();
  await expect(slider).toBeFocused();
  await expect(slider).toHaveAttribute('aria-valuetext', 'high');
});

test('artifact selection and removing selection focus the composer without moving the document', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '```opencode-artifact\n' + JSON.stringify({
    schema: 1, id: 'selection-scroll', version: 1, title: 'Selection example', kind: 'chart', chart: 'bar',
    xLabel: 'Batch', yLabel: 'Duration', unit: 'ms', series: [{ name: 'Measured', values: [{ x: 1, y: 12 }, { x: 2, y: 8 }] }],
  }) + '\n```' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  const stable = await watchRootScroll(page, '#header');
  await page.locator('[data-series="Measured"]').press('Enter');
  await page.getByRole('button', { name: 'Ask about selection' }).click();
  await stable();
  await expect(page.locator('#input')).toBeFocused();
  await expect(page.locator('#selection-context')).toBeVisible();
  await page.getByRole('button', { name: 'Remove selection' }).click();
  await stable();
  await expect(page.locator('#input')).toBeFocused();
  await expect(page.locator('#selection-context')).toBeHidden();
});

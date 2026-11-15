'use strict';

const { test, expect } = require('./fixture');

test('compact latest prompt sticks while the full message remains in the transcript', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Keep this question visible' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.locator('#messages').evaluate((node) => { node.style.scrollBehavior = 'auto'; node.scrollTop = 500; });
  const top = await page.locator('#messages').evaluate((node) => node.getBoundingClientRect().top);
  await expect(page.getByRole('button', { name: 'Go to latest prompt' })).toBeVisible();
  await expect.poll(async () => (await page.locator('.sticky-prompt button').boundingBox()).y).toBeCloseTo(top, 0);
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 900; });
  await expect.poll(async () => (await page.locator('.sticky-prompt button').boundingBox()).y).toBeCloseTo(top, 0);
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(async () => (await page.locator('.message.user').boundingBox()).y).toBeCloseTo(top + 16, 0);
  await expect(page.locator('.sticky-prompt button')).toBeHidden();
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'Next question' } });
  await expect(page.locator('.message.user').first()).toHaveCSS('position', 'static');
  await expect(page.locator('.message.user').last()).toHaveCSS('position', 'static');
  await expect(page.locator('.sticky-prompt')).toHaveCount(1);
  await expect(page.locator('.sticky-prompt button')).toHaveText('Next question');
});

for (const [kind, prompt] of [
  ['words', 'Есть ли системы, модели или агенты, которые заточены под оркестрирование? '.repeat(12)],
  ['unbroken text', 'VeryLongPromptWithoutAnySpaces'.repeat(40)],
]) {
  test(`a long pinned prompt clips ${kind} inside its right border with an ellipsis`, async ({ page, chat }) => {
    await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: prompt } });
    await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long answer.\n\n'.repeat(100) } });
    await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
    const messages = page.locator('#messages');
    await messages.evaluate((node) => { node.style.scrollBehavior = 'auto'; node.scrollTop = node.scrollHeight; });
    const button = page.getByRole('button', { name: 'Go to latest prompt' });
    await expect(button).toBeVisible();
    await expect(button).toHaveText(prompt.trim());
    await expect(button).toHaveCSS('white-space', 'nowrap');
    await expect(button).toHaveCSS('text-overflow', 'ellipsis');
    await expect(button).toHaveCSS('overflow-x', 'clip');

    const geometry = await button.evaluate((node) => {
      const viewport = document.getElementById('messages');
      const bounds = viewport.getBoundingClientRect();
      const padding = getComputedStyle(viewport);
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, height: rect.height,
        expectedLeft: bounds.left + parseFloat(padding.paddingLeft),
        expectedRight: bounds.right - parseFloat(padding.paddingRight),
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        viewportScrollWidth: viewport.scrollWidth, viewportClientWidth: viewport.clientWidth,
      };
    });
    expect(geometry.left).toBeCloseTo(geometry.expectedLeft, 0);
    expect(geometry.right, 'the rounded right border stays inside the viewport').toBeCloseTo(geometry.expectedRight, 0);
    expect(geometry.scrollWidth, 'the fixture really needs truncation').toBeGreaterThan(geometry.clientWidth);
    expect(geometry.viewportScrollWidth, 'the bubble never widens the transcript').toBe(geometry.viewportClientWidth);

    // Check rendered truncation, not merely text-overflow's computed value:
    // replacing ellipsis with clipping must change pixels at the visible edge.
    const clip = { x: Math.floor(geometry.right - 65), y: Math.floor(geometry.top), width: 65, height: Math.ceil(geometry.height) };
    const ellipsis = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    await button.evaluate((node) => { node.style.textOverflow = 'clip'; });
    const clipped = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    expect(ellipsis.equals(clipped), 'the ellipsis is rendered inside the visible right edge').toBe(false);
    await button.evaluate((node) => { node.style.textOverflow = ''; });
    await chat.snapshot('long-pinned-prompt');
  });
}

test('bottom collapse survives streamed output and returns focus to its summary', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'collapse-tool', title: 'Read output', kind: 'read', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'First result' } }] });
  const details = page.locator('details.tool-group');
  // While the turn runs the steps stream raw: no chevron, already expanded.
  await expect(page.locator('details.turn-steps > summary')).toBeHidden();
  await details.locator(':scope > summary').click();
  const collapse = details.locator(':scope > .disclosure-collapse');
  await expect(collapse).toBeVisible();
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'collapse-tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Updated result' } }] });
  await expect(collapse).toHaveCount(1);
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(details).not.toHaveAttribute('open', '');
  await expect(details.locator(':scope > summary')).toBeFocused();
  await expect(collapse).toBeHidden();
});

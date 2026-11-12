'use strict';

const { test, expect } = require('./fixture');
const { expectInside } = require('./root-scroll');
const text = (chat, value) => chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const end = chat => chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
const nativeText = (chat, id, value) => chat.send({ type: 'transcript', partial: true, messages: [{
  id, type: 'assistant', time: { created: 1767268800000 }, content: [{ type: 'text', text: value }],
}] });
const gap = page => page.locator('#messages').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
const table = '| Row | Value |\n| --- | --- |\n' + Array.from({ length: 80 }, (_, i) => `| ${i} | Value ${i} |`).join('\n');

for (const height of [280, 450]) {
  test(`short shell keeps controls reachable through combined interactions (${height}px)`, async ({ page, chat }) => {
    await page.setViewportSize({ ...page.viewportSize(), height });
    await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'long-prompt', content: { type: 'text', text: 'Full prompt line\n'.repeat(80) } });
    await text(chat, 'Answer paragraph.\n\n'.repeat(50));
    await end(chat);
    await expect(page.locator('.sticky-prompt button')).toBeVisible();
    expect(await page.locator('.sticky-prompt button').evaluate(node => node.clientHeight)).toBeLessThan(45);
    await page.locator('.sticky-prompt button').click();
    await expect(page.locator('.message.user')).toBeFocused();
    await expect(page.locator('.message.user .body')).toHaveText('Full prompt line\n'.repeat(80).trim());
    await chat.send({ type: 'subagents', items: Array.from({ length: 25 }, (_, i) => ({ id: `child-${i}`, title: `Worker ${i}`, running: true })) });
    await expectInside(page.locator('#subagents-summary'), page.locator('#app'));
    await expect(page.locator('#subagents-list')).toBeHidden();
    await page.locator('#subagents-summary').click();
    await expectInside(page.locator('#subagents-list'), page.locator('#app'));
    await page.locator('#subagents-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.locator('#subagents-summary').click();

    const option = { id: 'effort', name: 'Effort', type: 'select', currentValue: 'default', options: ['default', 'low', 'high'].map(value => ({ value, name: value })) };
    await chat.send({ type: 'config', configOptions: [option] });
    await page.locator('#input').fill('Draft line\n'.repeat(40));
    await page.locator('#input').press('Control+End');
    await page.locator('#input').press('PageDown');
    await expectInside(page.locator('#input'), page.locator('#app'));
    await page.getByRole('slider', { name: 'Effort' }).press('End');
    await chat.send({ type: 'config', configOptions: [{ ...option, currentValue: 'high' }] });
    await expect(page.getByRole('slider', { name: 'Effort' })).toBeFocused();
    await expectInside(page.getByRole('slider', { name: 'Effort' }), page.locator('#composer-controls'));

    await chat.send({ type: 'elicitation', requestId: 'short-question', message: 'Question context.\n\n'.repeat(50), requestedSchema: {
      type: 'object', properties: { answer: { type: 'string', title: 'Answer' } },
    } });
    const answer = page.locator('#questions input').first();
    await expect(answer).toBeFocused();
    await expectInside(answer, page.locator('#questions'));
    await answer.press('PageDown');
    await page.getByRole('button', { name: 'Jump to current message' }).click();
    await expectInside(answer, page.locator('#app'));
    expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThan(25);
  });

  test(`artifact panel has one viewport, including its controls (${height}px)`, async ({ page, chat }) => {
    await page.setViewportSize({ ...page.viewportSize(), height });
    await text(chat, '```opencode-artifact\n' + JSON.stringify({ schema: 1, id: 'large-table', version: 1, title: 'Large table', kind: 'markdown', content: table }) + '\n```');
    await end(chat);
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
    const panel = page.locator('#artifacts');
    await expectInside(panel, page.locator('#app'));
    await expect(panel.locator('table')).toBeVisible();
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expectInside(panel.locator('tr').last(), panel);
    await expect(panel.getByRole('button', { name: 'Source', exact: true })).toBeInViewport();
    await panel.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(panel.locator('.artifact-source')).toBeVisible();
    await expectInside(panel.getByRole('button', { name: 'Preview', exact: true }), panel);
  });
}

test('streaming follows the bottom, but user reading survives growth above and below it', async ({ page, chat }) => {
  for (let i = 0; i < 8; i++) {
    await chat.update({ sessionUpdate: 'user_message_chunk', messageId: `reader-${i}`, content: { type: 'text', text: `Prompt ${i}` } });
    await text(chat, `Answer ${i}.\n\n` + 'Paragraph.\n\n'.repeat(12));
    await end(chat);
  }
  await expect.poll(() => gap(page)).toBeLessThan(2);
  const viewport = page.locator('#messages');
  await viewport.hover();
  await page.mouse.wheel(0, -700);
  await expect.poll(() => gap(page)).toBeGreaterThan(600);
  const reading = await viewport.evaluate(node => {
    const index = [...node.children].findIndex(child => child.getBoundingClientRect().height > 0 && child.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
    return { index, y: node.children[index].getBoundingClientRect().top, top: node.scrollTop };
  });
  // Late image/diagram/font layout above the anchor: exercise ResizeObserver,
  // independently of the renderer calling any explicit scroll helper.
  const addedHeight = await page.locator('.message.user').first().evaluate(node => {
    const before = node.getBoundingClientRect().height;
    const late = document.createElement('div');
    late.style.height = '350px';
    node.append(late);
    return node.getBoundingClientRect().height - before;
  });
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeCloseTo(reading.top + addedHeight, 0);
  await nativeText(chat, 'stream-tail', 'New streamed output.\n\n'.repeat(25));
  await expect.poll(() => page.locator('#messages > *').nth(reading.index).evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(reading.y, 0);
  await page.locator('#input').fill('Draft\n'.repeat(30));
  await page.setViewportSize({ ...page.viewportSize(), height: 450 });
  await expect.poll(() => page.locator('#messages > *').nth(reading.index).evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(reading.y, 0);
  await end(chat);
  await page.getByRole('button', { name: 'Jump to current message' }).click();
  await expect.poll(() => gap(page)).toBeLessThan(2);
  await text(chat, '```mermaid\nflowchart TD\n' + Array.from({ length: 20 }, (_, i) => `N${i} --> N${i + 1}`).join('\n') + '\n```');
  await end(chat);
  await expect(page.locator('.diagram')).toHaveAttribute('data-rendered', 'ready');
  await expect.poll(() => gap(page)).toBeLessThan(2);
});

test('tool text and tables expand into the transcript without nested vertical scrolling', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'large-result', kind: 'read', title: 'Read long output', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Output line\n'.repeat(150) } }] });
  await text(chat, table);
  await end(chat);
  await page.locator('details.turn-steps > summary').click();
  await page.locator('.tool-group > summary').click();
  for (const selector of ['.tool-content pre', '.table-wrap']) {
    const dimensions = await page.locator(selector).first().evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight }));
    expect(dimensions.height).toBeGreaterThan(460);
    expect(dimensions.content - dimensions.height).toBeLessThanOrEqual(2);
  }
});

test('reading a long answer survives layout inside it and a streamed Markdown rerender', async ({ page, chat }) => {
  const initial = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  await nativeText(chat, 'stream-reading', initial);
  await expect(page.locator('.message.assistant p')).toHaveCount(80);
  await page.locator('#messages').evaluate(node => { node.scrollTop = 900; });
  const anchor = await page.locator('#messages').evaluate(node => {
    const paragraphs = [...node.querySelectorAll('.message.assistant p')];
    const index = paragraphs.findIndex(p => p.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
    return { index, y: paragraphs[index].getBoundingClientRect().top };
  });
  // A late intrinsic size change within the message, above the reading line.
  await page.locator('.message.assistant p').first().evaluate(node => { node.style.minHeight = '400px'; });
  const position = () => page.locator('.message.assistant p').nth(anchor.index).evaluate(node => node.getBoundingClientRect().top);
  await expect.poll(position).toBeCloseTo(anchor.y, 0);
  await nativeText(chat, 'stream-reading', initial + '\n\nAnother streamed paragraph.');
  await expect(page.locator('.message.assistant p')).toHaveCount(81);
  await expect.poll(position).toBeCloseTo(anchor.y, 0);
});

test('scrolling downward at the bottom keeps following subsequent output', async ({ page, chat }) => {
  const initial = 'Paragraph.\n\n'.repeat(100);
  await nativeText(chat, 'stream-bottom', initial);
  await expect.poll(() => gap(page)).toBeLessThan(2);
  await page.locator('#messages').hover();
  await page.mouse.wheel(0, 500);
  await nativeText(chat, 'stream-bottom', initial + 'More output.\n\n'.repeat(20));
  await expect.poll(() => gap(page)).toBeLessThan(2);
});

test.describe('animated navigation', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('deliberate navigation is not mistaken for following during streaming', async ({ page, chat }) => {
    await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'smooth-prompt', content: { type: 'text', text: 'Read this prompt' } });
    const initial = 'Paragraph.\n\n'.repeat(100);
    await nativeText(chat, 'stream-navigation', initial);
    await page.locator('.sticky-prompt button').click();
    await nativeText(chat, 'stream-navigation', initial + 'Output during navigation.\n\n'.repeat(20));
    await expect.poll(() => page.locator('#messages').evaluate(node => node.scrollTop)).toBeLessThan(25);
    await nativeText(chat, 'stream-navigation', initial + 'Output after navigation.\n\n'.repeat(40));
    await expect.poll(() => page.locator('#messages').evaluate(node => node.scrollTop)).toBeLessThan(25);
    await expect(page.locator('.message.user')).toBeFocused();
  });
});

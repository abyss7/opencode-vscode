'use strict';

const { test, expect } = require('./fixture');

test('the compact footer has a balanced gap above its metadata without changing the header', async ({ page, chat }, testInfo) => {
  await chat.send({ type: 'config', configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
    { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
  ] });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Text above the footer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.locator('#agent-label')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const messages = document.getElementById('messages').getBoundingClientRect();
    const composer = document.getElementById('composer').getBoundingClientRect();
    const label = document.getElementById('agent-label').getBoundingClientRect();
    const header = document.getElementById('header').getBoundingClientRect();
    const hint = document.querySelector('.hint').getBoundingClientRect();
    return {
      gap: label.top - messages.bottom,
      plateGap: composer.top - messages.bottom,
      headerHeight: header.height,
      bottomGap: innerHeight - hint.bottom,
    };
  });
  console.log(`${testInfo.project.name} footer spacing: ${JSON.stringify(geometry)}`);
  await testInfo.attach('footer-spacing', { body: JSON.stringify(geometry), contentType: 'application/json' });
  expect(geometry.headerHeight, 'the Ready header stays untouched').toBe(42);
  expect(geometry.bottomGap, 'the existing 8px composer + 2px controls inset stays untouched').toBe(10);
  expect(geometry.gap, 'the compact footer leaves about 20px, not a large empty band').toBeGreaterThanOrEqual(16);
  expect(geometry.gap, 'the compact footer leaves about 20px, not a large empty band').toBeLessThanOrEqual(24);
  expect(geometry.plateGap, 'the compact plate does not cover the transcript clip line').toBeGreaterThanOrEqual(0);
  await chat.snapshot('compact-footer-spacing');
});

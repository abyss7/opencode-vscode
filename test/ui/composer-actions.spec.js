'use strict';

const { test, expect } = require('./fixture');

test('composer action sits inside the bottom right corner without overlapping input or settings', async ({ page, chat }) => {
  await chat.send({ type: 'config', configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
    { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: [
      { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
    ] },
  ] });
  for (const text of ['', 'A multiline prompt\nwith another line\nand more text']) {
    await page.locator('#input').fill(text);
    const box = await page.locator('.prompt-box').boundingBox();
    const button = await page.locator('#send').boundingBox();
    const input = await page.locator('#input').boundingBox();
    const config = await page.locator('#config-bar').boundingBox();
    expect(box.x + box.width - button.x - button.width).toBeCloseTo(9, 0);
    expect(box.y + box.height - button.y - button.height).toBeCloseTo(9, 0);
    expect(input.y + input.height).toBeLessThanOrEqual(button.y);
    expect(config.x + config.width).toBeLessThanOrEqual(button.x);
  }
  await chat.snapshot('composer-actions');
});

test('stop replaces send only while busy with an empty draft', async ({ page, chat }) => {
  const send = page.locator('#send');
  const stop = page.locator('#stop');
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(stop).toBeHidden();
  const initial = await send.boundingBox();
  await chat.send({ type: 'status', state: 'busy' });
  await expect(send).toBeHidden();
  await expect(stop).toBeVisible();
  expect(await stop.boundingBox()).toEqual(initial);
  await page.locator('#input').fill('Next message');
  await expect(stop).toBeHidden();
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(async () => (await chat.received('prompt')).length).toBe(1);
  await expect(stop).toBeVisible();
  await page.locator('#input').fill('   ');
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(async () => (await chat.received('cancel')).length).toBe(1);
  await expect(stop).toBeDisabled();
  await chat.send({ type: 'status', state: 'ready' });
  await expect(stop).toBeHidden();
  await expect(send).toBeVisible();
});

test('an image-only draft keeps send instead of stop while busy', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await page.locator('#input').evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'context.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#attachments img')).toBeVisible();
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#stop')).toBeHidden();
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(page.locator('#stop')).toBeVisible();
});

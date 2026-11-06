'use strict';

const { test, expect } = require('./fixture');
const statuses = ['queued', 'running', 'completed', 'cancelled'];
const names = ['Queued', 'Running', 'Completed', 'Cancelled'];

async function showMessages(chat, states = statuses) {
  await chat.send({ type: 'transcript', messages: states.map((status, index) => ({
    id: `msg_${status}`, type: 'user', text: 'Сделай коммит своих изменений',
    time: { created: 1767268800000 + index * 1000 },
  })), inbox: [], states: states.map((status) => [`msg_${status}`, status]) }, { type: 'historyEnd' });
}

const appearance = (page) => page.locator('.message.user .body').evaluateAll((nodes) => nodes.map((node) => {
  const css = getComputedStyle(node);
  return { border: css.borderColor, line: css.borderStyle, text: css.color, background: css.backgroundColor };
}));

test('status is accessible without a visible extra line and follows live theme changes', async ({ page, chat }) => {
  await showMessages(chat);
  for (const [index, status] of statuses.entries()) {
    const message = page.locator(`[data-message-id="msg_${status}"]`);
    await expect(message).toHaveAttribute('title', names[index]);
    await expect(message.getByRole('status')).toHaveText(names[index]);
    await expect(message.locator('.body')).toHaveAttribute('aria-describedby', `delivery-msg_${status}`);
  }
  expect(await page.locator('.delivery-status').evaluateAll((nodes) => nodes.every((node) => {
    const css = getComputedStyle(node);
    return css.position === 'absolute' && css.clipPath === 'inset(50%)' && node.getBoundingClientRect().height <= 1;
  }))).toBe(true);
  const before = await appearance(page);
  expect(before[0].line).toBe('solid');
  expect(new Set(before.map((item) => item.border)).size).toBe(4);
  const height = await page.locator('#messages').evaluate((node) => node.scrollHeight);
  // A theme can choose completely different hues. No reload or JS update is needed.
  await page.evaluate(() => {
    const colors = { 'testing-iconQueued': '#df73c0', 'progressBar-background': '#79bb71',
      'testing-iconPassed': '#a98fe2', 'testing-iconSkipped': '#ac8539',
      foreground: '#c3d4e5', descriptionForeground: '#91a2b3' };
    for (const [token, color] of Object.entries(colors)) document.documentElement.style.setProperty(`--vscode-${token}`, color);
  });
  const after = await appearance(page);
  for (let index = 0; index < statuses.length; index++) {
    if (statuses[index] === 'queued') expect(after[index].border).toBe(before[index].border);
    else expect(after[index].border).not.toBe(before[index].border);
    expect(after[index].text).not.toBe(before[index].text);
  }
  expect(await page.locator('#messages').evaluate((node) => node.scrollHeight)).toBe(height);
});

test('latest prompt status badges never overflow horizontally', async ({ page, chat }) => {
  const message = page.locator('[data-message-id="msg_queued"]');
  for (const state of ['queued', 'unknown', 'cancelled', 'failed']) {
    await chat.send({ type: 'submission', id: 'msg_queued', state,
      item: { id: 'msg_queued', type: 'user', payload: { text: 'Сделай коммит своих изменений' } } });
    await expect(message).toHaveAttribute('data-delivery', state);
    expect(await message.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const badge = await message.locator('.delivery-indicator').boundingBox();
    const box = await message.boundingBox();
    expect(badge.x + badge.width + 4).toBeLessThanOrEqual(box.x + box.width);
  }
  await message.locator('button.delivery-indicator').focus();
  expect(await message.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('unconfirmed and failed inputs keep their meaning and image-only inputs have a status border', async ({ page, chat }) => {
  await showMessages(chat, ['sending', 'unknown', 'failed', 'interrupted']);
  await expect(page.locator('[data-message-id="msg_unknown"]')).toHaveAttribute('title', 'Message undelivered.');
  await expect(page.locator('[data-message-id="msg_interrupted"]')).toHaveAttribute('title', 'Interrupted');
  expect((await appearance(page)).map((item) => item.line)).toEqual(['solid', 'solid', 'solid', 'dashed']);
  await chat.send({ type: 'submission', id: 'msg_image', state: 'failed', error: 'Upload rejected', item: {
    id: 'msg_image', type: 'user', payload: { files: [{
      uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    }] },
  } });
  const imageMessage = page.locator('[data-message-id="msg_image"]');
  await expect(imageMessage.locator('.body')).toBeHidden();
  await expect(imageMessage).toHaveAttribute('title', 'Message undelivered — click icon to resend.');
  await expect(imageMessage).toHaveAttribute('data-delivery-error', 'Upload rejected');
  await expect(imageMessage.locator('.user-images')).toHaveAttribute('aria-describedby', 'delivery-msg_image');
  const colors = await page.evaluate(() => [
    getComputedStyle(document.querySelector('[data-message-id="msg_failed"] .body')).borderColor,
    getComputedStyle(document.querySelector('[data-message-id="msg_image"] img')).borderColor,
  ]);
  expect(colors[1]).toBe(colors[0]);
});

test('high contrast uses the theme contrast border and retains full text contrast', async ({ page, chat }, testInfo) => {
  await showMessages(chat);
  await page.evaluate((theme) => {
    document.body.className = theme === 'dark' ? 'vscode-high-contrast' : 'vscode-high-contrast-light';
    document.documentElement.style.setProperty('--vscode-contrastBorder', '#ecbf41');
    document.documentElement.style.setProperty('--vscode-foreground', '#c3d4e5');
  }, testInfo.project.metadata.theme);
  for (const item of await appearance(page)) {
    expect(item.border).toBe('rgb(236, 191, 65)');
    expect(item.text).toBe('rgb(195, 212, 229)');
  }
});

test('queued input has a passive clock badge at the bottom-right of the bubble', async ({ page, chat }) => {
  await showMessages(chat);
  const bubble = page.locator('[data-message-id="msg_queued"] .body');
  const badge = bubble.getByRole('img', { name: 'Queued' });
  await expect(badge).toBeVisible();
  expect(await badge.evaluate((node) => getComputedStyle(node).color))
    .toBe(await bubble.evaluate((node) => getComputedStyle(node).color));
  await expect(bubble.getByRole('button')).toHaveCount(0);
  const a = await bubble.boundingBox(), b = await badge.boundingBox();
  expect(Math.abs(b.x + b.width / 2 - a.x - a.width)).toBeLessThan(10);
  expect(Math.abs(b.y + b.height / 2 - a.y - a.height)).toBeLessThan(10);
  await badge.click();
  expect(await chat.received('resend')).toEqual([]);
  expect(await chat.received('prompt')).toEqual([]);
});

for (const status of ['unknown', 'cancelled', 'failed']) {
  test(`${status} input can be resent once with its original ID and payload after reload`, async ({ page, chat }) => {
    const item = { id: 'msg_retry', type: 'user', time: { created: 1767268801000 }, payload: {
      text: 'Please retry\n\n<opencode-client-context version="1">original context</opencode-client-context>',
      files: [{ uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=' }],
      metadata: { original: true },
    } };
    await chat.send({ type: 'submission', id: item.id, state: status, item });
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.hostMessages.some((m) => m.type === 'ready'))).toBe(true);
    await chat.send({ type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true },
      { type: 'historyEnd' }, { type: 'status', state: 'ready' });
    const message = page.locator(`[data-message-id="${item.id}"]`);
    const resend = message.getByRole('button', { name: 'Resend message' });
    await expect(resend).toBeVisible();
    await expect(message).toHaveAttribute('title', 'Message undelivered — click icon to resend.');
    await page.locator('#input').fill('Unrelated draft');
    await resend.focus();
    await page.keyboard.press('Enter');
    await expect(resend).toHaveCount(0);
    await expect(message).toHaveAttribute('data-delivery', 'sending');
    expect(await chat.received('resend')).toEqual([{ type: 'resend', item }]);
    await expect(page.locator('#input')).toHaveValue('Unrelated draft');
    await chat.send({ type: 'submission', id: item.id, state: 'queued', item });
    await expect(message.getByRole('img', { name: 'Queued' })).toBeVisible();
    await chat.send({ type: 'transcript', messages: [{ id: item.id, type: 'user', text: 'Please retry', time: item.time }],
      inbox: [], states: [[item.id, 'running']] });
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.delivery-indicator')).toHaveCount(0);
    expect(await chat.received('resend')).toHaveLength(1);
  });
}

for (const imageOnly of [false, true]) {
  test(`status badges never move or resize ${imageOnly ? 'image-only' : 'wrapped text'} messages`, async ({ page, chat }) => {
    const text = imageOnly ? '' : 'Сообщение для проверки стабильной геометрии. '.repeat(7).trim();
    const files = imageOnly ? [{ uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=' }] : [];
    const item = { id: 'msg_geometry', type: 'user', time: { created: 1767268801000 }, payload: { text, files } };
    await chat.send({ type: 'transcript', messages: [{ id: 'msg_earlier', type: 'user', text: 'Earlier', time: { created: 1767268800000 } }],
      inbox: [], states: [] }, { type: 'historyEnd' }, { type: 'submission', id: item.id, state: 'sending', item });
    const message = page.locator(`[data-message-id="${item.id}"]`);
    const content = message.locator(imageOnly ? '.user-images' : '.body');
    const geometry = async () => ({
      message: await message.boundingBox(), content: await content.boundingBox(),
      scrollHeight: await page.locator('#messages').evaluate((node) => node.scrollHeight),
    });
    const baseline = await geometry();
    for (const status of ['queued', 'unknown', 'cancelled', 'failed']) {
      await chat.send({ type: 'submission', id: item.id, state: status, item });
      await expect(message.locator('.delivery-indicator')).toBeVisible();
      expect(await geometry()).toEqual(baseline);
    }
    await message.getByRole('button', { name: 'Resend message' }).click();
    await expect(message.locator('.delivery-indicator')).toHaveCount(0);
    expect(await geometry()).toEqual(baseline);
    await chat.send({ type: 'submission', id: item.id, state: 'queued', item },
      { type: 'transcript', messages: [{ id: item.id, type: 'user', text, files, time: item.time }],
        inbox: [], states: [[item.id, 'running']] });
    await expect(message.locator('.delivery-indicator')).toHaveCount(0);
    expect(await geometry()).toEqual(baseline);
    await chat.send({ type: 'transcript', messages: [], inbox: [], states: [[item.id, 'completed']] });
    expect(await geometry()).toEqual(baseline);
  });
}

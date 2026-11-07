'use strict';

const { test, expect } = require('./fixture');

test('cold startup hides unstyled content until the chat stylesheet arrives', async ({ page, chat }) => {
  // Keep the real HTML and CSP, but hold the stylesheet across a new document.
  let releaseStyles;
  const stylesReady = new Promise((resolve) => { releaseStyles = resolve; });
  await page.route('**/media/chat.css', async (route) => {
    await stylesReady;
    await route.fallback();
  });
  try {
    await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('#empty')).toBeAttached();
    await expect(page.locator('.empty-logo')).toBeHidden();
    await expect(page.locator('#header')).toBeHidden();
  } finally {
    releaseStyles();
    await page.waitForLoadState('load');
  }

  const logo = page.locator('.empty-logo');
  await expect(logo).toBeVisible();
  await expect(page.locator('#header')).toBeVisible();
  const box = await logo.boundingBox();
  expect(box.width).toBe(54);
  expect(box.height).toBe(54);
  await expect(logo.locator('.logo-frame')).not.toHaveCSS('fill', 'rgb(0, 0, 0)');
  await chat.snapshot('styled-startup');
});

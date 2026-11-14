'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('./fixture');

const phases = (count) => Array.from({ length: count }, (_, p) => ({
  id: `p${p + 1}`, title: `Phase ${p + 1}`,
  tasks: Array.from({ length: 6 }, (_, t) => ({
    id: `p${p + 1}t${t + 1}`, title: `Task ${p + 1}.${t + 1}`,
    status: p * 6 + t < 4 ? 'done' : p * 6 + t === 4 ? 'doing' : 'todo',
  })),
}));
const planMessage = (version, extra = {}) => ({
  type: 'plan', id: 'scroll-plan', title: 'Scroll plan', sessionTitle: 'Session plan',
  latest: version, overlay: {}, dirty: [],
  versions: [{ version, value: { schema: 1, id: 'scroll-plan', version, title: 'Scroll plan', kind: 'plan', phases: phases(8) } }],
  ...extra,
});
const taskTop = (page, id) => page.evaluate((taskId) => {
  const row = document.querySelector(`.task[data-task-id="${taskId}"]`);
  return row ? Math.round(row.getBoundingClientRect().top) : null;
}, id);

test.beforeEach(async ({ page }) => {
  // The plan document itself is the scroll surface; the chat shell contract
  // does not apply to this page.
  await page.addInitScript(() => {
    window.__testRootOverflow = true;   // the plan document is the scroll surface
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.hostMessages.push(message) });
  });
  const html = (await fs.readFile(path.join(__dirname, '../../media/plan.html'), 'utf8'))
    .replaceAll('{{cspSource}}', 'https://opencode.test')
    .replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{styleUri}}', 'https://opencode.test/media/plan.css')
    .replaceAll('{{scriptUri}}', 'https://opencode.test/media/plan.js');
  await page.route('https://opencode.test/plan', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://opencode.test/media/plan.js', async (route) =>
    route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(path.join(__dirname, '../../media/plan.js'), 'utf8') }));
  await page.route('https://opencode.test/media/plan.css', async (route) =>
    route.fulfill({ contentType: 'text/css', body: await fs.readFile(path.join(__dirname, '../../media/plan.css'), 'utf8') }));
  await page.goto('https://opencode.test/plan');
  await expect.poll(() => page.evaluate(() => window.hostMessages.length)).toBeGreaterThan(0);
});

test('plan pushes keep the reader on their task', async ({ page }) => {
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), planMessage(1));
  await expect(page.locator('.task[data-task-id="p4t1"]')).toBeVisible();
  // Scroll to a middle task like a reader following progress.
  await page.evaluate(() => {
    const row = document.querySelector('.task[data-task-id="p4t1"]');
    row.scrollIntoView();
    document.scrollingElement.scrollTop -= 40;
  });
  const parkedTop = await taskTop(page, 'p4t1');

  // A new version arrives with a task inserted above the reader.
  const grown = planMessage(2, {
    versions: [{ version: 2, value: { schema: 1, id: 'scroll-plan', version: 2, title: 'Scroll plan', kind: 'plan',
      phases: phases(8).map((phase, index) => index === 0 ? { ...phase, tasks: [{ id: 'p1t0', title: 'Fresh task', status: 'todo' }, ...phase.tasks] } : phase) } }],
  });
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), grown);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => Math.round(document.scrollingElement.scrollTop))).toBeGreaterThan(200);
  expect(Math.abs((await taskTop(page, 'p4t1')) - parkedTop), 'version push keeps the task in place').toBeLessThan(2);

  // A status tick (overlay/dirty push) re-renders the same version.
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), {
    type: 'state', id: 'scroll-plan', latest: 2, overlay: { p4t1: 'done' }, dirty: ['p4t1'],
  });
  await page.waitForTimeout(80);
  expect(Math.abs((await taskTop(page, 'p4t1')) - parkedTop), 'status push keeps the task in place').toBeLessThan(2);
});

test('deliberately viewing an old revision survives newer pushes', async ({ page }) => {
  const revision = (version) => ({ version, value: { schema: 1, id: 'scroll-plan', version, title: 'Scroll plan', kind: 'plan', phases: phases(2) } });
  const push = (versions) => page.evaluate((message) =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), {
    type: 'plan', id: 'scroll-plan', title: 'Scroll plan', sessionTitle: 'Session plan',
    latest: Math.max(...versions.map((item) => item.version)), overlay: {}, dirty: [], versions,
  });
  await push([revision(1)]);
  await push([revision(1), revision(2)]);
  await expect(page.locator('#plan-versions')).toHaveValue('2');
  await page.locator('#plan-versions').selectOption('1');
  await expect(page.locator('#plan-old')).toBeVisible();
  await push([revision(1), revision(2), revision(3)]);
  await expect(page.locator('#plan-versions')).toHaveValue('1');
  await expect(page.locator('#plan-old')).toBeVisible();
});

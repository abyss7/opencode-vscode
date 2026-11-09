'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { test: base, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '../..');
const origin = 'https://opencode.test';

function themeCss(theme) {
  const dark = theme === 'dark';
  const colors = {
    foreground: dark ? '#cccccc' : '#333333',
    'editor-background': dark ? '#1e1e1e' : '#ffffff',
    'editorWidget-background': dark ? '#252526' : '#f3f3f3',
    descriptionForeground: dark ? '#9d9d9d' : '#616161',
    'input-background': dark ? '#313131' : '#ffffff',
    'input-foreground': dark ? '#cccccc' : '#333333',
    'input-border': dark ? '#464646' : '#cecece',
    'widget-border': dark ? '#454545' : '#d4d4d4',
    'textCodeBlock-background': dark ? '#252526' : '#f3f3f3',
    'textPreformat-foreground': dark ? '#d7ba7d' : '#a31515',
    'textLink-foreground': dark ? '#4daafc' : '#005fb8',
    'textLink-activeForeground': dark ? '#75beff' : '#005fb8',
    'button-background': '#0078d4',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': dark ? '#313131' : '#e5e5e5',
    'button-secondaryForeground': dark ? '#cccccc' : '#333333',
    'list-hoverBackground': dark ? '#2a2d2e' : '#f0f0f0',
    'list-activeSelectionBackground': '#0078d4',
    'list-activeSelectionForeground': '#ffffff',
    'focusBorder': '#0078d4',
    'errorForeground': dark ? '#f48771' : '#a1260d',
    'testing-iconPassed': dark ? '#73c991' : '#388a34',
    'testing-iconFailed': dark ? '#f14c4c' : '#e51400',
    'testing-iconQueued': dark ? '#cca700' : '#a66d00',
    'testing-iconSkipped': dark ? '#848484' : '#707070',
    'progressBar-background': dark ? '#0e70c0' : '#0063a5',
    'charts-green': dark ? '#89d185' : '#388a34',
    'charts-orange': dark ? '#d18616' : '#b46b00',
  };
  return `:root { color-scheme: ${theme};
    --vscode-font-family: Arial, sans-serif;
    --vscode-editor-font-family: "DejaVu Sans Mono", monospace;
    --vscode-font-size: 13px;
    --vscode-chat-font-size: 13px;
    ${Object.entries(colors).map(([key, value]) => `--vscode-${key}: ${value};`).join('\n')}
  }`;
}

const test = base.extend({
  resourceOrigin: [origin, { option: true }],
  chat: async ({ page, resourceOrigin }, use, testInfo) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('requestfailed', (request) => errors.push(`Failed request: ${request.url()}`));
    await page.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'));
    await page.addInitScript(() => {
      window.hostMessages = [];
      window.layoutViolations = [];
      // Continuous shell contract, including transient native focus/caret moves.
      function checkShell() {
        const root = document.scrollingElement;
        const app = document.querySelector('#app');
        const ready = app ? getComputedStyle(app).display !== 'none' : document.querySelector('#sessions-scroll');
        if (root && ready && !window.__testRootOverflow) {
          const geometry = [scrollX, scrollY, document.body.scrollLeft, document.body.scrollTop,
            root.scrollWidth - innerWidth, root.scrollHeight - innerHeight];
          if (geometry.some(value => Math.abs(value) > 1) && window.layoutViolations.length < 5) {
            window.layoutViolations.push(geometry);
          }
        }
        requestAnimationFrame(checkShell);
      }
      requestAnimationFrame(checkShell);
      let state = JSON.parse(sessionStorage.getItem('vscode-state') || 'null');
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          window.hostMessages.push(message);
          if (message.type === 'checkFiles') {
            window.postMessage({
              type: 'fileChecks',
              files: message.files.map((file) => ({ ...file, exists: file.path === 'src/api.js' })),
            }, '*');
          }
        },
        setState(value) { state = value; sessionStorage.setItem('vscode-state', JSON.stringify(value)); },
        getState() { return state; },
      });
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin && url.origin !== resourceOrigin) {
        errors.push(`Unexpected external request: ${url.href}`);
        return route.abort();
      }
      if (url.pathname === '/') {
        const providerIcons = await fs.readFile(path.join(root, 'media/provider-icons.svg'), 'utf8');
        const html = (await fs.readFile(path.join(root, 'media/chat.html'), 'utf8'))
          .replaceAll('{{cspSource}}', `${origin} ${resourceOrigin}`)
          .replaceAll('{{nonce}}', 'test-nonce')
          .replaceAll('{{styleUri}}', `${resourceOrigin}/media/chat.css`)
          .replaceAll('{{richTextUri}}', `${resourceOrigin}/media/rich-text.js`)
          .replaceAll('{{richTextStyleUri}}', `${resourceOrigin}/media/rich-text.css`)
          .replaceAll('{{diagramsUri}}', `${resourceOrigin}/media/diagrams.js`)
          .replaceAll('{{modelPickerUri}}', `${resourceOrigin}/media/model-picker.js`)
          .replaceAll('{{scriptUri}}', `${resourceOrigin}/media/chat.js`)
          .replace('{{providerIcons}}', () => providerIcons)
          .replace('<body>', `<body class="vscode-${testInfo.project.metadata.theme}">`)
          .replace('<title>', '<link rel="stylesheet" href="/theme.css"><title>');
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      if (url.pathname === '/theme.css') {
        return route.fulfill({ contentType: 'text/css', body: themeCss(testInfo.project.metadata.theme) });
      }
      if (!url.pathname.startsWith('/media/')) return route.fulfill({ status: 404 });
      const file = path.resolve(root, `.${url.pathname}`);
      if (!file.startsWith(path.join(root, 'media') + path.sep)) return route.abort();
      const types = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) });
    });

    const send = async (...messages) => page.evaluate((items) => {
      for (const data of items) window.dispatchEvent(new MessageEvent('message', { data }));
    }, messages);
    const snapshot = async (name) => {
      await page.evaluate(() => document.fonts.ready);
      const file = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      await testInfo.attach(name, { path: file, contentType: 'image/png' });
    };
    await page.goto(origin);
    await expect.poll(() => page.evaluate(() => window.hostMessages.some((item) => item.type === 'ready'))).toBe(true);
    await send(
      { type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true },
      { type: 'sessionInfo', title: 'Visual workspace' },
      { type: 'capabilities', images: true },
      { type: 'status', state: 'ready' }
    );
    await use({
      send,
      update: (update) => send({ type: 'update', update }),
      received: (type) => page.evaluate((kind) => window.hostMessages.filter((item) => item.type === kind), type),
      snapshot,
    });
    if (!page.isClosed()) {
      await snapshot('final');
      expect(await page.evaluate(() => window.layoutViolations), 'The document is never a scroll region').toEqual([]);
      expect(await page.evaluate(() => {
        const allowed = '#messages, #input, #questions, #composer-controls, #artifacts, .model-picker-list, .slash-menu, .subagents-list, #sessions-scroll, #connection-error, .defaults-footer';
        return [...document.querySelectorAll('body *')].filter(node => node.clientHeight > 0 &&
          node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(node).overflowY) &&
          !node.matches(allowed)).map(node => node.id || node.className || node.tagName);
      }), 'Only designated regions may scroll vertically').toEqual([]);
    }
    expect(errors, 'Browser, resource and CSP errors').toEqual([]);
  },
});

module.exports = { test, expect };

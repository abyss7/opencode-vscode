'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const output = process.env.OPENCODE_UI_OUTPUT || path.join(__dirname, '../../test-results/ui');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  outputDir: path.join(output, 'results'),
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(output, 'report'), open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: ['dark', 'light'].flatMap((theme) =>
    [380, 1100].map((width) => ({
      name: `${theme}-${width}`,
      metadata: { theme },
      use: { viewport: { width, height: 900 }, colorScheme: theme },
    }))
  ),
});

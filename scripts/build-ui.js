'use strict';

const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/webview/rich-text.js'],
  outfile: 'media/rich-text.js',
  bundle: true,
  format: 'iife',
  globalName: 'OpenCodeRichText',
  platform: 'browser',
  target: 'chrome108',
  minify: true,
  legalComments: 'linked',
  footer: { js: 'if (typeof module !== "undefined") module.exports = OpenCodeRichText;' },
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

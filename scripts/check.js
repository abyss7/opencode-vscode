'use strict';

/**
 * @file Syntax check across all extension, webview, plugin, script, and media
 * JavaScript entry points. Automatically discovers new modules so `package.json`
 * does not need a hand-maintained file list.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'plugins', 'scripts', 'media', 'test'];

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'fonts') continue;
      collectJsFiles(full, out);
    } else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = DIRS.flatMap((dir) => collectJsFiles(path.join(ROOT, dir))).sort();
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`Syntax OK (${files.length} files)`);

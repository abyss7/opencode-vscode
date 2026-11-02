'use strict';

const assert = require('node:assert');
const { parseFileReference, resolveFileTarget } = require('../src/file-links');

// Plain paths without coordinates.
assert.deepStrictEqual(parseFileReference('src/api.js'), {
  path: 'src/api.js',
  line: null,
  column: null,
});

// `path:line` and `path:line:column`.
assert.deepStrictEqual(parseFileReference('src/api.js:42'), {
  path: 'src/api.js',
  line: 42,
  column: null,
});
assert.deepStrictEqual(parseFileReference('src/api.js:42:7'), {
  path: 'src/api.js',
  line: 42,
  column: 7,
});

// `path#L42` and `path#L42C7`.
assert.deepStrictEqual(parseFileReference('src/api.js#L42'), {
  path: 'src/api.js',
  line: 42,
  column: null,
});
assert.deepStrictEqual(parseFileReference('src/api.js#L42C7'), {
  path: 'src/api.js',
  line: 42,
  column: 7,
});

// Wrapping quotes and backticks are stripped.
assert.deepStrictEqual(parseFileReference('`src/api.js:9`'), {
  path: 'src/api.js',
  line: 9,
  column: null,
});

// Windows drive letters are not line numbers.
assert.deepStrictEqual(parseFileReference('C:\\work\\file.js'), {
  path: 'C:\\work\\file.js',
  line: null,
  column: null,
});

// File URLs are decoded.
assert.deepStrictEqual(parseFileReference('file:///work/a%20b.js#L3'), {
  path: '/work/a b.js',
  line: 3,
  column: null,
});

assert.strictEqual(parseFileReference(''), null);
assert.strictEqual(parseFileReference('   '), null);

// Relative references resolve against the session directory.
assert.deepStrictEqual(resolveFileTarget('/work', 'src/api.js:42'), {
  filePath: '/work/src/api.js',
  line: 42,
  column: null,
});
assert.deepStrictEqual(resolveFileTarget('/work', './src/../lib/a.ts:1:2'), {
  filePath: '/work/lib/a.ts',
  line: 1,
  column: 2,
});

// Absolute paths inside the workspace stay absolute.
assert.deepStrictEqual(resolveFileTarget('/work', '/work/src/api.js:5'), {
  filePath: '/work/src/api.js',
  line: 5,
  column: null,
});

// Paths outside the workspace (absolute, `..`, `~`) are rejected so a chat
// reference cannot open arbitrary files.
assert.strictEqual(resolveFileTarget('/work', '/etc/hosts:3'), null);
assert.strictEqual(resolveFileTarget('/work', '../secret.txt'), null);
assert.strictEqual(resolveFileTarget('/work', '~/notes.md'), null);

console.log('FILE LINKS OK');

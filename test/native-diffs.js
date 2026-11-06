'use strict';

const assert = require('node:assert/strict');
const { applyUnified } = require('../src/native-diffs');
const patch = '--- a\n+++ b\n@@ -1,3 +1,3 @@\n same\n-old\n+new\n tail\n';
assert.equal(applyUnified('same\nnew\ntail\n', patch, true), 'same\nold\ntail\n');
assert.equal(applyUnified('same\nold\ntail\n', patch), 'same\nnew\ntail\n');
assert.equal(applyUnified('same\nchanged-again\ntail\n', patch, true), null);
assert.equal(applyUnified('', '@@ -1 +0,0 @@\n-gone\n', true), 'gone\n');
assert.equal(applyUnified('', '@@ -0,0 +1 @@\n+new\n'), 'new\n');
assert.equal(applyUnified('new', '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', true), 'old');
assert.equal(applyUnified('new\n', '@@ -1,2 +1 @@\n-old\n+new\n', true), null, 'truncated hunks are rejected');
console.log('NATIVE DIFFS OK');

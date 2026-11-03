'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const providers = new Map();
const commands = [];
const vscode = {
  Uri: { from: ({ scheme, path }) => ({ scheme, path, toString() { return `${scheme}:${path}`; } }) },
  ViewColumn: { Beside: -2 },
  workspace: { registerTextDocumentContentProvider(scheme, provider) {
    providers.set(scheme, provider);
    return { dispose() { providers.delete(scheme); } };
  } },
  commands: { async executeCommand(...args) { commands.push(args); } },
};
const load = Module._load;
Module._load = function (name) { return name === 'vscode' ? vscode : load.apply(this, arguments); };
const { DiffDocuments } = require('../src/diff-documents');
Module._load = load;

(async () => {
  const first = new DiffDocuments();
  const second = new DiffDocuments();
  await first.open({ path: 'src/a.js', oldText: 'old\n', newText: 'new\n' });
  await first.open({ path: 'src/a.js', oldText: null, newText: 'created' });
  await second.open({ path: 'src/a.js', oldText: 'deleted', newText: '' });
  await first.open({ oldText: {}, newText: 'bad' });
  assert.equal(commands.length, 3);
  const contents = commands.map(([command, left, right, title, options]) => {
    assert.equal(command, 'vscode.diff');
    assert.equal(options.viewColumn, -2);
    assert.match(title, /a.js/);
    assert.equal(left.path.endsWith('.js'), true);
    return [providers.get(left.scheme).provideTextDocumentContent(left), providers.get(right.scheme).provideTextDocumentContent(right)];
  });
  assert.deepEqual(contents, [['old\n', 'new\n'], ['', 'created'], ['deleted', '']]);
  assert.notEqual(commands[0][1].toString(), commands[1][1].toString());
  first.dispose();
  assert.equal(providers.size, 1);
  second.dispose();
  assert.equal(providers.size, 0);
  console.log('DIFF DOCUMENTS OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

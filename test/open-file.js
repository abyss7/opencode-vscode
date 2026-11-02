'use strict';

const assert = require('node:assert');
const Module = require('node:module');

const opened = [];
const shown = [];

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

const vscode = {
  Uri: {
    joinPath: (base, ...parts) => [base, ...parts].join('/'),
    file: (value) => ({ scheme: 'file', fsPath: value }),
    parse: (value) => value,
  },
  Position,
  Range,
  ViewColumn: { Active: 1, Beside: -2 },
  workspace: {
    openTextDocument: async (uri) => {
      if (String(uri.fsPath).includes('missing')) {
        throw new Error('cannot open missing file');
      }
      const document = { uri, fileName: uri.fsPath };
      opened.push(document);
      return document;
    },
  },
  window: {
    showTextDocument: async (document, options) => {
      shown.push({ document, options });
      return document;
    },
  },
  env: { openExternal: async () => true },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const { SessionPanel } = require('../src/session-panel');

function createPanel() {
  let receive = null;
  let disposeHandler = null;
  const messages = [];
  const webview = {
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri) => uri,
    postMessage: async (message) => {
      messages.push(message);
      return true;
    },
    onDidReceiveMessage: (listener) => {
      receive = listener;
      return { dispose: () => {} };
    },
  };
  const panel = {
    title: '',
    iconPath: null,
    active: true,
    webview,
    onDidDispose: (listener) => {
      disposeHandler = listener;
      return { dispose: () => {} };
    },
    reveal: () => {},
    dispose() {
      if (disposeHandler) disposeHandler();
    },
  };
  return { panel, messages, receive: (message) => receive(message) };
}

const logs = [];

(async () => {
  const { panel, messages, receive } = createPanel();
  const deps = {
    extensionUri: '/ext',
    api: {},
    log: (message) => logs.push(message),
    getConfig: () => ({ command: 'opencode' }),
    onSessionCreated: () => {},
    onSessionDisposed: () => {},
    onSessionChanged: () => {},
  };

  const sessionPanel = new SessionPanel({
    panel,
    sessionId: null,
    cwd: '/work',
    deps,
  });

  // A relative path with a line opens beside the chat at that line.
  receive({ type: 'openFile', path: 'src/api.js', line: 42, column: 7 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(opened.length, 1, 'the file must be opened');
  assert.strictEqual(opened[0].uri.fsPath, '/work/src/api.js');
  assert.strictEqual(shown.length, 1, 'the document must be shown');
  assert.strictEqual(shown[0].options.viewColumn, -2);
  assert.strictEqual(shown[0].options.selection.start.line, 41);
  assert.strictEqual(shown[0].options.selection.start.character, 6);

  // Coordinates may come inside the reference itself.
  receive({ type: 'openFile', path: 'src/api.js:5:2' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(shown.length, 2);
  assert.strictEqual(shown[1].options.selection.start.line, 4);
  assert.strictEqual(shown[1].options.selection.start.character, 1);

  // Absolute paths inside the workspace open; paths outside are rejected so a
  // chat reference cannot open arbitrary files.
  receive({ type: 'openFile', path: '/work/src/api.js:1:1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(opened[2].uri.fsPath, '/work/src/api.js');
  assert.strictEqual(shown[2].options.selection.start.line, 0);

  receive({ type: 'openFile', path: '/etc/hosts' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(opened.length, 3, 'an out-of-workspace path must not open');

  receive({ type: 'openFile', path: 'missing.js:3' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(shown.length, 3, 'a missing file must not open an editor');
  assert.ok(logs.some((line) => line.includes('missing.js')));

  // Only existing, in-workspace files are reported back as linkable.
  receive({
    type: 'checkFiles',
    files: [
      { key: 'a', path: 'src/api.js' },
      { key: 'b', path: 'missing.js' },
      { key: 'c', path: '/etc/hosts' },
      { key: 'd', path: '/etc' },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const checks = messages.find((message) => message.type === 'fileChecks');
  assert.ok(checks, 'checkFiles must answer with fileChecks');
  assert.deepStrictEqual(checks.files, [
    { key: 'a', exists: false },
    { key: 'b', exists: false },
    { key: 'c', exists: false },
    { key: 'd', exists: false },
  ]);

  sessionPanel.dispose();
  console.log('OPEN FILE OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

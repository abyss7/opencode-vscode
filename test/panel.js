'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeApi } = require('../src/api');

const cwd = process.env.OPENCODE_TEST_CWD || path.join(os.tmpdir(), 'opencode-acp-test');
fs.mkdirSync(cwd, { recursive: true });

class Emitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }

  dispose() {
    this.listeners = [];
  }
}

const vscode = {
  Uri: {
    joinPath: (base, ...parts) => [base, ...parts].join('/'),
    parse: (value) => value,
  },
  ViewColumn: { Active: 1 },
  env: { openExternal: async () => true },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const { SessionPanel } = require('../src/session-panel');

function createPanel() {
  const messages = [];
  let receive = null;
  let disposeHandler = null;
  let viewStateHandler = null;
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
    html: '',
  };
  const panel = {
    title: '',
    iconPath: null,
    active: false,
    webview,
    onDidDispose: (listener) => {
      disposeHandler = listener;
      return { dispose: () => {} };
    },
    onDidChangeViewState: (listener) => {
      viewStateHandler = listener;
      return { dispose: () => {} };
    },
    reveal: () => {},
    dispose() {
      if (disposeHandler) disposeHandler();
    },
  };
  return {
    panel,
    messages,
    receive: (message) => receive(message),
    activate() {
      panel.active = true;
      if (viewStateHandler) viewStateHandler({ webviewPanel: panel });
    },
  };
}

function waitFor(messages, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for message'));
      }
    }, 50);
  });
}

(async () => {
  const api = new OpenCodeApi({ command: 'opencode', log: console.log });
  const { panel, messages, receive, activate } = createPanel();
  const logs = [];
  const deps = {
    extensionUri: path.resolve(__dirname, '..'),
    api,
    log: (message) => {
      logs.push(message);
      console.log('[log]', message);
    },
    getConfig: () => ({ command: 'opencode', autoApprovePermissions: 'ask' }),
    onSessionCreated: () => {},
    onSessionDisposed: () => {},
    onSessionChanged: () => {},
  };

  const sessionPanel = new SessionPanel({ panel, sessionId: null, cwd, deps });
  assert.ok(panel.webview.html.includes('OpenCode'), 'html was not rendered');
  receive({ type: 'ready' });

  const sessionMessage = await waitFor(messages, (m) => m.type === 'session', 30000);
  console.log('session message:', sessionMessage.sessionId);
  await waitFor(messages, (m) => m.type === 'status' && m.state === 'ready', 30000);
  assert.ok(
    String(panel.iconPath.light).includes('opencode-light.svg'),
    'an idle tab keeps the default icon'
  );

  receive({ type: 'prompt', text: 'Reply with exactly: PANEL-OK' });
  await waitFor(messages, (m) => m.type === 'status' && m.state === 'busy', 30000);
  assert.ok(
    String(panel.iconPath).includes('opencode-working.svg'),
    'a working tab must be orange'
  );
  await waitFor(messages, (m) => m.type === 'turnEnd', 120000);
  const transcript = new Map();
  for (const event of messages.filter((message) => message.type === 'transcript')) {
    for (const message of event.messages) transcript.set(message.id, message);
  }
  const answers = [...transcript.values()].filter((message) => message.type === 'assistant');
  const assistantText = answers.flatMap((message) => message.content
    .filter((part) => part.type === 'text').map((part) => part.text)).join('');
  console.log('assistant text:', JSON.stringify(assistantText));
  assert.ok(assistantText.includes('PANEL-OK'), 'panel did not render assistant text');
  await sessionPanel._restoreTurnStats();
  const times = messages.filter((message) => message.type === 'messageTimes').flatMap((message) => message.times);
  const answerIds = answers.map((message) => message.id);
  assert.ok(answerIds.length > 0 && answerIds.every((id) => times.some((time) => time.id === id && time.timestamp > 0)),
    'server timestamps must match the message IDs rendered in the panel');
  assert.ok(
    String(panel.iconPath).includes('opencode-done.svg'),
    'a finished unseen tab must be green'
  );

  activate();
  assert.ok(
    String(panel.iconPath.light).includes('opencode-light.svg'),
    'the icon returns to normal once the answer is seen'
  );
  await waitFor(messages, (m) => m.type === 'focus', 5000);
  assert.ok(
    messages.some((m) => m.type === 'focus'),
    'focusing the tab must focus the composer'
  );

  sessionPanel.dispose();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await api.deleteSession(sessionMessage.sessionId);
  console.log('PANEL OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

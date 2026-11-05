'use strict';

process.env.OPENCODE_DISABLE_SETTINGS_SYNC = '1';

const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

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

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

const panels = [];
const commands = new Map();
const output = [];
const errors = [];
let serializer = null;
let treeProvider = null;
let sidebarView = null;
const pendingInputs = [];
const pendingPicks = [];
const mementoStore = new Map();
const memento = {
  get: (key, fallback) => (mementoStore.has(key) ? mementoStore.get(key) : fallback),
  update: async (key, value) => {
    mementoStore.set(key, value);
  },
};

function createWebview() {
  const messageListeners = [];
  const disposeListeners = [];
  const messages = [];
  const panel = {
    title: '',
    iconPath: null,
    webview: {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri) => uri,
      html: '',
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
      onDidReceiveMessage: (listener) => {
        messageListeners.push(listener);
        return { dispose: () => {} };
      },
    },
    onDidDispose: (listener) => {
      disposeListeners.push(listener);
      return { dispose: () => {} };
    },
    reveal: () => {},
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    dispose() {
      for (const listener of disposeListeners) listener();
    },
    async send(message) {
      await Promise.all(messageListeners.map((listener) => listener(message)));
    },
    messages,
  };
  return panel;
}

const vscode = {
  EventEmitter: Emitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Active: 1 },
  Uri: {
    file: (fsPath) => ({ fsPath, scheme: 'file' }),
    joinPath: (base, ...parts) => [base, ...parts].join('/'),
    parse: (value) => value,
  },
  env: { openExternal: async () => true },
  commands: {
    registerCommand: (name, handler) => {
      commands.set(name, handler);
      return { dispose: () => commands.delete(name) };
    },
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      appendLine: (line) => output.push(line),
      show: () => {},
      dispose: () => {},
    }),
    registerWebviewViewProvider: (id, provider) => {
      assert.strictEqual(id, 'opencode.sessions');
      treeProvider = provider.provider;
      sidebarView = createWebview();
      provider.resolveWebviewView(sidebarView);
      return { dispose: () => sidebarView.dispose() };
    },
    createWebviewPanel: () => {
      const panel = createWebview();
      panels.push(panel);
      return panel;
    },
    registerWebviewPanelSerializer: (type, value) => {
      serializer = value;
      return { dispose: () => {} };
    },
    showWarningMessage: async () => 'Delete',
    showInputBox: async () =>
      pendingInputs.length > 0 ? pendingInputs.shift() : undefined,
    showQuickPick: async (items) => {
      if (pendingPicks.length === 0) return undefined;
      const wanted = pendingPicks.shift();
      return (
        items.find((item) => item.folderId === wanted || item.label === wanted) ||
        undefined
      );
    },
    showErrorMessage: async (message) => {
      errors.push(String(message));
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeWindowState: () => ({ dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: cwd }, name: 'acp-test' }],
    getConfiguration: () => ({
      inspect: () => ({}),
      get: (key, fallback) => {
        if (key === 'command') return 'opencode';
        if (key === 'autoApprovePermissions') return 'ask';
        return fallback;
      },
    }),
    getWorkspaceFolder: () => ({ uri: { fsPath: cwd }, name: 'acp-test' }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const extension = require('../src/extension');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, description) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + description);
}

const context = {
  extensionUri: path.resolve(__dirname, '..'),
  globalState: memento,
  subscriptions: [],
};

(async () => {
  extension.activate(context);
  await waitFor(() => treeProvider, 5000, 'tree provider');
  await sidebarView.send({ type: 'ready' });
  await sleep(1500);

  const groups = () => treeProvider.getChildren();
  const groupByName = (name) => groups().find((group) => group.name === name);
  const allSessions = () =>
    groups().reduce((items, group) => items.concat(group.sessions || []), []);
  const findSession = (id) => allSessions().find((item) => item.id === id);

  const initial = allSessions();
  console.log('initial sessions:', initial.length);
  console.log('initial groups:', groups().map((group) => `${group.name}:${group.sessions.length}`).join(', '));
  assert.ok(groupByName('Ungrouped'), 'the default Ungrouped folder is missing');
  assert.ok(groupByName('Archived'), 'the system Archived folder is missing');
  assert.strictEqual(groupByName('Ungrouped').system, 'ungrouped');
  assert.strictEqual(groupByName('Archived').system, 'archived');

  await commands.get('opencode.newSession')();
  const panel = await waitFor(() => panels[0], 5000, 'webview panel');
  assert.ok(panel.webview.html.includes('OpenCode'));
  panel.send({ type: 'ready' });

  const sessionMessage = await waitFor(
    () => panel.messages.find((message) => message.type === 'session'),
    30000,
    'session creation'
  );
  console.log('created', sessionMessage.sessionId);
  await waitFor(
    () => panel.messages.find((message) => message.type === 'status' && message.state === 'ready'),
    30000,
    'ACP ready'
  );

  panel.send({ type: 'prompt', text: 'Reply with exactly: EXT-OK' });
  await waitFor(
    () => panel.messages.find((message) => message.type === 'turnEnd'),
    120000,
    'turn end'
  );
  const assistantText = panel.messages
    .filter((message) => message.type === 'update' && message.update.sessionUpdate === 'agent_message_chunk')
    .map((message) => message.update.content && message.update.content.text)
    .join('');
  console.log('assistant:', JSON.stringify(assistantText));
  assert.ok(assistantText.includes('EXT-OK'));

  await sleep(1000);
  const session = findSession(sessionMessage.sessionId);
  assert.ok(session, 'new session is missing from the tree');
  console.log('tree title:', session.title);

  await sleep(4000);
  const titled = findSession(sessionMessage.sessionId);
  console.log('titles after wait:', JSON.stringify(panel.title), JSON.stringify(titled && titled.title));

  // A sidebar refresh must repair a missing ACP title update in the open tab.
  panel.title = 'OpenCode';
  await commands.get('opencode.refreshSessions')();
  assert.strictEqual(panel.title, findSession(session.id).title);
  const titleUpdates = panel.messages.filter((message) => message.type === 'sessionInfo').length;
  await commands.get('opencode.refreshSessions')();
  assert.strictEqual(panel.messages.filter((message) => message.type === 'sessionInfo').length, titleUpdates,
    'unchanged titles should not be reposted on every sidebar refresh');

  // Folders: create, drag and drop, rename, archive/restore, quick pick move, delete.
  pendingInputs.push('Work');
  await commands.get('opencode.newFolder')();
  let work = groupByName('Work');
  assert.ok(work, 'the Work folder was not created');
  assert.strictEqual(treeProvider.getTreeItem(work).description, 'empty');

  await sidebarView.send({ type: 'sidebarAction', action: 'drop',
    sidebarKind: 'session', sidebarId: session.id, folderId: work.id });
  work = groupByName('Work');
  assert.ok(
    work.sessions.some((item) => item.id === session.id),
    'drag and drop did not move the session into the folder'
  );
  assert.ok(
    !groupByName('Ungrouped').sessions.some((item) => item.id === session.id),
    'the moved session is still in Ungrouped'
  );

  pendingInputs.push('EXT renamed');
  await commands.get('opencode.renameSession')(session);
  const renamed = findSession(session.id);
  assert.strictEqual(renamed.title, 'EXT renamed');
  assert.strictEqual(panel.title, 'EXT renamed');

  await commands.get('opencode.archiveSession')(renamed);
  const archived = groupByName('Archived');
  assert.ok(
    archived.sessions.some((item) => item.id === session.id),
    'the archived session is missing from Archived'
  );
  assert.ok(
    !groupByName('Work').sessions.some((item) => item.id === session.id),
    'the archived session is still in Work'
  );

  await commands.get('opencode.restoreSession')(archived.sessions[0]);
  assert.ok(
    groupByName('Work').sessions.some((item) => item.id === session.id),
    'restoring the session did not return it to Work'
  );

  pendingPicks.push('Ungrouped');
  await commands.get('opencode.moveSessionTo')(
    groupByName('Work').sessions.find((item) => item.id === session.id)
  );
  assert.ok(
    groupByName('Ungrouped').sessions.some((item) => item.id === session.id),
    'quick pick move did not return the session to Ungrouped'
  );

  await commands.get('opencode.deleteFolder')(groupByName('Work'));
  assert.strictEqual(groupByName('Work'), undefined, 'the folder was not deleted');

  panel.dispose();
  await sleep(1000);
  await commands.get('opencode.openSession')(renamed);
  const reopened = panels[1];
  assert.ok(reopened, 'reopened panel was not created');
  assert.strictEqual(reopened.title, 'EXT renamed', 'known title must be visible before ACP starts');
  reopened.send({ type: 'ready' });
  const loadedMessage = await waitFor(
    () => reopened.messages.find((message) => message.type === 'session'),
    30000,
    'session load'
  );
  assert.strictEqual(loadedMessage.sessionId, sessionMessage.sessionId);
  assert.strictEqual(loadedMessage.loaded, true);
  await waitFor(
    () => reopened.messages.find((message) => message.type === 'historyEnd'),
    30000,
    'history replay'
  );
  const replayText = reopened.messages
    .filter((message) => message.type === 'update' && message.update.sessionUpdate === 'agent_message_chunk')
    .map((message) => message.update.content && message.update.content.text)
    .join('');
  console.log('replayed:', JSON.stringify(replayText));
  assert.ok(replayText.includes('EXT-OK'), 'history was not replayed in the reopened panel');

  await commands.get('opencode.deleteSession')(session);
  await sleep(1500);
  assert.ok(
    !findSession(sessionMessage.sessionId),
    'session is still in the tree after deletion'
  );
  assert.strictEqual(errors.length, 0, 'unexpected error: ' + errors.join('; '));

  console.log('EXTENSION OK');
})().catch((error) => {
  console.error(error.stack || error);
  for (const panel of panels) {
    for (const message of panel.messages.filter((item) => item.type === 'error')) {
      console.error(message.message);
    }
  }
  process.exitCode = 1;
}).finally(() => {
  for (const disposable of context.subscriptions.reverse()) {
    if (disposable && typeof disposable.dispose === 'function') disposable.dispose();
  }
});

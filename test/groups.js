'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const { SessionFolders } = require('../src/session-folders');

class Emitter {
  constructor() {
    this.listeners = [];
  }

  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }

  fire() {
    for (const listener of this.listeners) listener();
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

const vscode = {
  EventEmitter: Emitter,
  TreeItem,
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const { SessionsProvider } = require('../src/sessions-view');

function createMemento() {
  const store = new Map();
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      store.set(key, value);
    },
  };
}

class FakeApi {
  constructor() {
    this.records = new Map();
    this.calls = [];
  }

  add(session) {
    this.records.set(session.id, { archived: false, ...session });
  }

  remove(sessionId) {
    this.records.delete(sessionId);
  }

  async listSessions(directory, options = {}) {
    const archived = options.archived === true;
    return [...this.records.values()]
      .filter(
        (session) =>
          (session.archived === true) === archived &&
          session.location.directory === directory &&
          !session.parentID
      )
      .map((session) => {
        const copy = { ...session };
        delete copy.archived;
        return copy;
      })
      .sort(
        (a, b) =>
          ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0)
      );
  }

  async listSubagents(directory) {
    return [...this.records.values()]
      .filter(
        (session) =>
          session.archived !== true &&
          session.location.directory === directory &&
          session.parentID
      )
      .map((session) => ({ ...session }));
  }

  async updateSession(sessionId, patch) {
    this.calls.push({ id: sessionId, patch });
    const session = this.records.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    Object.assign(session, patch);
  }
}

const cwd = '/work';
const groupByName = (provider, name) =>
  provider.getChildren().find((group) => group.name === name);

(async () => {
  const memento = createMemento();
  const folders = new SessionFolders(memento);
  const api = new FakeApi();
  api.add({
    id: 'ses_1',
    title: 'One',
    time: { updated: 3 },
    location: { directory: cwd },
  });
  api.add({
    id: 'ses_2',
    title: 'Two',
    time: { updated: 2 },
    location: { directory: cwd },
  });
  api.add({
    id: 'ses_1a',
    title: 'Sub One',
    parentID: 'ses_1',
    time: { updated: 1 },
    location: { directory: cwd },
  });

  const provider = new SessionsProvider(api, () => cwd, () => {}, folders);
  await provider.refresh();

  assert.deepStrictEqual(
    provider.getChildren().map((group) => group.name),
    ['Ungrouped', 'Archived']
  );
  assert.deepStrictEqual(
    groupByName(provider, 'Ungrouped').sessions.map((session) => session.id),
    ['ses_1', 'ses_2']
  );

  const ungroupedItem = provider.getTreeItem(groupByName(provider, 'Ungrouped'));
  assert.strictEqual(ungroupedItem.id, 'folder:ungrouped');
  assert.strictEqual(ungroupedItem.description, '2');
  assert.strictEqual(ungroupedItem.contextValue, 'opencode.folder.ungrouped');
  assert.strictEqual(ungroupedItem.iconPath.id, 'inbox');

  const sessionItem = provider.getTreeItem(
    groupByName(provider, 'Ungrouped').sessions[0]
  );
  assert.strictEqual(sessionItem.contextValue, 'opencode.session');
  assert.strictEqual(sessionItem.session.id, 'ses_1');

  // Sub-agents nest under their parent session and never appear in a folder.
  const ses1 = groupByName(provider, 'Ungrouped').sessions.find(
    (session) => session.id === 'ses_1'
  );
  const subagentChildren = provider.getChildren(ses1);
  assert.deepStrictEqual(
    subagentChildren.map((session) => session.id),
    ['ses_1a']
  );
  assert.strictEqual(provider.getTreeItem(ses1).collapsibleState, 1);
  assert.strictEqual(
    provider.getTreeItem(ses1).description,
    '1 sub-agent'
  );
  const subagentItem = provider.getTreeItem(subagentChildren[0]);
  assert.strictEqual(subagentItem.contextValue, 'opencode.session.subagent');
  assert.strictEqual(subagentItem.iconPath.id, 'server-process');
  assert.strictEqual(provider.find('ses_1a').id, 'ses_1a');

  // A local folder move never touches the server.
  folders.add(cwd, 'Work');
  await provider.refresh();
  assert.strictEqual(folders.list(cwd).length, 1);
  assert.strictEqual(await provider.moveSession('ses_1', 'Work'), true);
  await provider.refresh();
  assert.deepStrictEqual(
    groupByName(provider, 'Work').sessions.map((session) => session.id),
    ['ses_1']
  );
  assert.deepStrictEqual(api.calls, []);
  assert.strictEqual(provider.folderIdOf('ses_1'), 'Work');
  assert.strictEqual(provider.folderIdOf('ses_2'), 'ungrouped');

  // Archiving patches the server and shows up in the Archived folder.
  assert.strictEqual(await provider.moveSession('ses_1', 'archived'), true);
  assert.deepStrictEqual(api.calls.pop(), {
    id: 'ses_1',
    patch: { archived: true },
  });
  await provider.refresh();
  assert.strictEqual(provider.isArchived('ses_1'), true);
  assert.deepStrictEqual(
    groupByName(provider, 'Archived').sessions.map((session) => session.id),
    ['ses_1']
  );
  assert.strictEqual(
    provider.getTreeItem(groupByName(provider, 'Archived').sessions[0])
      .contextValue,
    'opencode.session.archived'
  );

  // Restoring returns the session to the folder it came from.
  assert.strictEqual(await provider.moveSession('ses_1', 'Work'), true);
  assert.deepStrictEqual(api.calls.pop(), {
    id: 'ses_1',
    patch: { archived: false },
  });
  await provider.refresh();
  assert.deepStrictEqual(
    groupByName(provider, 'Work').sessions.map((session) => session.id),
    ['ses_1']
  );

  // Unknown folders are ignored, and deleted sessions lose their assignment.
  assert.strictEqual(await provider.moveSession('ses_1', 'Missing'), false);
  api.remove('ses_1');
  await provider.refresh();
  assert.strictEqual(folders.folderOf(cwd, 'ses_1'), null);
  assert.deepStrictEqual(
    groupByName(provider, 'Work').sessions.map((session) => session.id),
    []
  );

  assert.deepStrictEqual(
    provider.folderChoices().map((choice) => choice.folderId),
    ['ungrouped', 'Work', 'archived']
  );

  provider.dispose();
  console.log('GROUPS OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

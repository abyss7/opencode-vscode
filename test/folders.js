'use strict';

const assert = require('node:assert');
const Module = require('node:module');

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
}

const vscode = {
  EventEmitter: Emitter,
  TreeItem: class {},
  ThemeIcon: class {},
  ThemeColor: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const {
  SessionFolders,
  UNGROUPED_ID,
  ARCHIVED_ID,
} = require('../src/session-folders');
const { buildGroups } = require('../src/sessions-view');

function createMemento() {
  const store = new Map();
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      store.set(key, value);
    },
  };
}

const cwd = '/work';

// Folders persist through a memento and are normalised on the way in.
const memento = createMemento();
const folders = new SessionFolders(memento);
assert.deepStrictEqual(folders.list(cwd), []);
assert.strictEqual(folders.validate(cwd, '   '), 'Folder name cannot be empty.');
assert.ok(folders.validate(cwd, 'Ungrouped'));
assert.ok(folders.validate(cwd, 'Archived'));
assert.strictEqual(folders.validate(cwd, 'Front end'), null);
folders.add(cwd, '  Front   end  ');
assert.deepStrictEqual(folders.list(cwd), ['Front end']);
assert.ok(folders.validate(cwd, 'front END'), 'folder names must be unique');
assert.throws(() => folders.add(cwd, 'FRONT END'));

const restored = new SessionFolders(memento);
assert.deepStrictEqual(restored.list(cwd), ['Front end']);

// Assignments survive restarts and are dropped together with their folder.
folders.assign(cwd, 'ses_a', 'Front end');
assert.strictEqual(folders.folderOf(cwd, 'ses_a'), 'Front end');
folders.assign(cwd, 'ses_a', null);
assert.strictEqual(folders.folderOf(cwd, 'ses_a'), null);
folders.assign(cwd, 'ses_b', 'Front end');
assert.ok(folders.remove(cwd, 'Front end'));
assert.strictEqual(folders.folderOf(cwd, 'ses_b'), null);
assert.deepStrictEqual(folders.list(cwd), []);

// Unknown folders are rejected instead of silently swallowed.
folders.add(cwd, 'One');
assert.throws(() => folders.assign(cwd, 'ses_c', 'Missing'));

// Pruning drops assignments for sessions that no longer exist.
folders.assign(cwd, 'ses_keep', 'One');
folders.assign(cwd, 'ses_drop', 'One');
assert.ok(folders.prune(cwd, ['ses_keep']));
assert.strictEqual(folders.folderOf(cwd, 'ses_keep'), 'One');
assert.strictEqual(folders.folderOf(cwd, 'ses_drop'), null);
assert.strictEqual(folders.prune(cwd, ['ses_keep']), false);

// Grouping: Ungrouped first, custom folders alphabetically, Archived last.
const active = [
  { id: 'ses_1', title: 'One', time: { updated: 3 } },
  { id: 'ses_2', title: 'Two', time: { updated: 2 } },
  { id: 'ses_3', title: 'Three', time: { updated: 1 } },
];
const archived = [{ id: 'ses_4', title: 'Four', time: { updated: 4 } }];
const state = {
  folders: ['Work', 'Later'],
  assignments: { ses_1: 'Work', ses_2: 'Later', ses_3: 'Gone', ses_4: 'Work' },
};
const groups = buildGroups(state, active, archived);
assert.deepStrictEqual(
  groups.map((group) => group.name),
  ['Ungrouped', 'Later', 'Work', 'Archived']
);
assert.deepStrictEqual(
  groups.map((group) => group.system),
  ['ungrouped', 'custom', 'custom', 'archived']
);
assert.deepStrictEqual(
  groups[0].sessions.map((session) => session.id),
  ['ses_3']
);
assert.deepStrictEqual(
  groups[1].sessions.map((session) => session.id),
  ['ses_2']
);
assert.deepStrictEqual(
  groups[2].sessions.map((session) => session.id),
  ['ses_1']
);
assert.deepStrictEqual(
  groups[3].sessions.map((session) => session.id),
  ['ses_4']
);
assert.strictEqual(groups[0].id, UNGROUPED_ID);
assert.strictEqual(groups[3].id, ARCHIVED_ID);

// An empty state still yields the two system folders.
const empty = buildGroups(null, [], []);
assert.deepStrictEqual(
  empty.map((group) => group.name),
  ['Ungrouped', 'Archived']
);

console.log('FOLDERS OK');

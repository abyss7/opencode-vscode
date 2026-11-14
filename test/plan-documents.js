'use strict';

// Host-side plan tab lifecycle: ingest, dedupe, overlay, pending updates,
// dismissal, session cleanup and export — all against a stubbed VS Code.

const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
const locked = [];
const panels = [];
const writes = [];
const saved = [];
let planTab = 'beside';

Module._load = function (name) {
  if (name !== 'vscode') return originalLoad.apply(this, arguments);
  return {
    ViewColumn: { Beside: 8, Two: 2 },
    Uri: { joinPath: (...parts) => ({ fsPath: parts.map((p) => p.fsPath || p).join('/'), scheme: 'file' }) },
    window: {
      createWebviewPanel(viewType, title, show, options) {
        const posted = [];
        const listeners = [];
        const panel = {
          viewType, title, viewColumn: show.viewColumn ?? 8, options,
          webview: {
            cspSource: 'https://webview.test',
            asWebviewUri: (uri) => ({ toString: () => `https://webview.test/${uri.fsPath}` }),
            html: '',
            postMessage: async (message) => { posted.push(message); },
            onDidReceiveMessage: (handler) => {
              listeners.push(handler);
              return { dispose() {} };
            },
          },
          onDidDispose: (handler) => {
            panel._disposed = handler;
            return { dispose() {} };
          },
          reveal() {},
          dispose() { panel._disposed?.(); },
          posted,
          receive(message) { for (const handler of listeners) handler(message); },
        };
        panels.push(panel);
        return panel;
      },
      showSaveDialog: async (options) => { saved.push(options); return { scheme: 'file', path: '/chosen/plan.md' }; },
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => (key === 'planTab' ? planTab : fallback) }),
      fs: { writeFile: async (...args) => { writes.push(args); } },
    },
    commands: { executeCommand: async (name) => { locked.push(name); } },
  };
};

const { PlanDocuments } = require('../src/plan-documents');
Module._load = originalLoad;

const tick = () => new Promise((resolve) => setImmediate(resolve));

const v1 = {
  schema: 1, id: 'setup', version: 1, title: 'Account setup', kind: 'plan',
  phases: [{ id: 'p1', title: 'Prep', tasks: [
    { id: 't1', title: 'Create account', status: 'todo' },
    { id: 't2', title: 'Enable 2FA', status: 'doing' },
  ] }],
};
const version = (v, statuses) => JSON.stringify({ ...v1, version: v, phases: [{ id: 'p1', title: 'Prep', tasks: [
  { id: 't1', title: 'Create account', status: statuses[0] },
  { id: 't2', title: 'Enable 2FA', status: statuses[1], note: statuses[2] },
] }] });

(async () => {
  const manager = new PlanDocuments({ extensionUri: { fsPath: '/ext' }, log() {} });

  // Non-plans and broken sources are ignored.
  assert.equal(manager.ingest('ses1', JSON.stringify({ ...v1, kind: 'markdown', content: 'x' })), false);
  assert.equal(manager.ingest('ses1', 'not json'), false);

  // Ingesting a plan opens a tab beside the chat, locked as a group.
  assert.equal(manager.ingest('ses1', version(1, ['todo', 'doing'])), true);
  assert.equal(panels.length, 1);
  const panel = panels[0];
  assert.equal(panel.viewType, 'opencode.plan');
  assert.equal(panel.title, 'Account setup');
  assert.ok(!panel.webview.html.includes('{{'), 'template placeholders are replaced');
  await tick();
  assert.ok(locked.includes('workbench.action.lockEditorGroup'), 'the plan group gets locked');

  panel.receive({ type: 'ready' });
  const init = panel.posted.find((message) => message.type === 'plan');
  assert.equal(init.id, 'setup');
  assert.equal(init.latest, 1);
  assert.deepEqual(init.versions.map((item) => item.version), [1]);
  assert.deepEqual(init.overlay, {});
  assert.deepEqual(init.dirty, []);

  // History replay of the same version changes nothing.
  assert.equal(manager.ingest('ses1', version(1, ['todo', 'doing'])), false);
  assert.equal(panels.length, 1);

  // A user tick becomes pending until a prompt consumes it.
  assert.equal(manager.setStatus('ses1', 'setup', 't1', 'done'), true);
  assert.equal(manager.setStatus('ses1', 'setup', 't1', 'later'), false, 'unknown statuses are rejected');
  assert.equal(manager.setStatus('ses1', 'setup', 'missing', 'done'), false, 'unknown tasks are rejected');
  let state = panel.posted.at(-1);
  assert.equal(state.type, 'state');
  assert.deepEqual(state.overlay, { t1: 'done' });
  assert.deepEqual(state.dirty, ['t1']);
  assert.deepEqual(manager.pendingUpdates('ses1'), [
    { id: 'setup', title: 'Account setup', version: 1, changes: [{ taskId: 't1', from: 'todo', to: 'done' }] },
  ]);
  assert.equal(manager.pendingUpdates('ses1'), null, 'updates are consumed once');

  // A new version that already reflects the overlay absorbs it.
  manager.ingest('ses1', version(2, ['done', 'doing', 'SMS pending']));
  const after = panel.posted.find((message) => message.type === 'plan' && message.latest === 2);
  assert.ok(after, 'the open tab receives the new version');
  assert.deepEqual(after.overlay, {}, 'absorbed overlay entries disappear');
  assert.equal(manager.pendingUpdates('ses1'), null);

  // A new version that ignores the change keeps it pending.
  manager.setStatus('ses1', 'setup', 't2', 'done');
  manager.ingest('ses1', version(3, ['done', 'doing']));
  assert.deepEqual(manager.pendingUpdates('ses1'), [
    { id: 'setup', title: 'Account setup', version: 3, changes: [{ taskId: 't2', from: 'doing', to: 'done' }] },
  ]);

  // Reverting to the artifact status removes a pending change.
  manager.setStatus('ses1', 'setup', 't2', 'doing');
  assert.equal(manager.pendingUpdates('ses1'), null);

  // Closing the tab dismisses the plan even for new versions, until revealed.
  panel.dispose();
  manager.ingest('ses1', version(4, ['done', 'done']));
  assert.equal(panels.length, 1, 'a dismissed plan does not reopen by itself');
  assert.equal(manager.reveal('ses1', 'setup'), true);
  assert.equal(panels.length, 2, 'reveal reopens the tab');
  panels[1].receive({ type: 'ready' });
  assert.equal(panels[1].posted.find((message) => message.type === 'plan').latest, 4);

  // Export writes the offered markdown through the save dialog.
  panels[1].receive({ type: 'export', name: 'setup.md', markdown: '# Plan\n' });
  await tick();
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].path, '/chosen/plan.md');
  assert.equal(writes[0][1].toString(), '# Plan\n');
  assert.equal(saved[0].filters.Markdown[0], 'md');

  // Manual mode keeps plans off-screen until asked.
  planTab = 'manual';
  manager.ingest('ses2', JSON.stringify({ ...v1, id: 'other', title: 'Other' }));
  assert.equal(panels.length, 2, 'manual mode does not auto-open');
  assert.equal(manager.reveal('ses2', 'other'), true);
  assert.equal(panels.length, 3);
  planTab = 'beside';

  // Session titles reach the tab, closing a chat closes and forgets its plans.
  manager.setSessionTitle('ses2', 'Refactoring');
  assert.ok(panels[2].posted.some((message) => message.type === 'state' && message.sessionTitle === 'Refactoring'));
  manager.closeSession('ses2');
  assert.equal(manager.pendingUpdates('ses2'), null);
  assert.equal(manager.reveal('ses2', 'other'), false, 'session plans are forgotten with the chat');

  manager.dispose();
  console.log('PLAN DOCUMENTS OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

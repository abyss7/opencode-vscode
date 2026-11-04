'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { SessionsSidebar } = require('../src/sessions-sidebar');
const { agentLabel, normalizeAgentOptions } = require('../src/agent-label');

async function main() {
  assert.equal(agentLabel('build', 'build'), 'Build');
  assert.equal(agentLabel('build', 'Build'), 'Build');
  assert.equal(agentLabel('plan'), 'Plan');
  assert.equal(agentLabel('reviewer', 'Security review'), 'Security review');
  const original = [{ id: 'mode', options: [{ value: 'build', name: 'build' }] }];
  assert.equal(normalizeAgentOptions(original)[0].options[0].name, 'Build');
  assert.equal(original[0].options[0].name, 'build', 'display normalization never mutates server configuration');
  let selected = 'build';
  const sent = [];
  let receive;
  const session = { id: 'ses_root', title: 'Task' };
  const child = { id: 'ses_child', title: 'Review', parentID: session.id };
  const folder = { kind: 'folder', id: 'work', name: 'Work', system: 'custom' };
  const calls = [];
  const provider = new SessionsSidebar({
    vscode: { Uri: { joinPath: (...parts) => parts.join('/') } },
    extensionUri: path.join(__dirname, '..'), getCwd: () => '/project', defaultAgent: () => selected,
    log: () => {}, setDefaultAgent: async (id) => { selected = id; },
    provider: {
      refresh: async () => {},
      getChildren: (node) => !node ? [folder] : node === folder ? [session] : node === session ? [child] : [],
      getTreeItem: (node) => ({ label: node.name || node.title, contextValue: 'opencode.session', iconPath: { id: 'comment-discussion' } }),
    },
    actions: {
      openSession: (node) => calls.push(['open', node.id]),
      renameSession: (node) => calls.push(['rename', node.id]),
      deleteFolder: (node) => calls.push(['deleteFolder', node.id]),
    },
    moveToFolder: (node, folderId) => calls.push(['move', node.id, folderId]),
    api: { listAgents: async () => [
      { id: 'build', name: 'build', mode: 'primary' },
      { id: 'plan', name: 'Plan', mode: 'primary' },
      { id: 'permission-classifier', mode: 'subagent', hidden: true },
      { id: 'worker', mode: 'subagent' },
    ] },
  });
  const view = { onDidDispose() {}, onDidChangeVisibility() {}, webview: {
    cspSource: 'test:', asWebviewUri: (uri) => uri,
    onDidReceiveMessage: (handler) => { receive = handler; },
    postMessage: async (message) => { sent.push(message); },
  } };
  provider.resolveWebviewView(view);
  assert.match(view.webview.html, /Content-Security-Policy/);
  await receive({ type: 'ready' });
  const tree = sent.find((message) => message.type === 'sessions').items;
  assert.equal(tree[0].children[0].children[0].id, child.id, 'subagents stay nested');
  assert.equal(provider.resolveContext({ sidebarKind: 'session', sidebarId: session.id }), session);
  await receive({ type: 'sidebarAction', action: 'openSession', sidebarKind: 'session', sidebarId: session.id });
  await receive({ type: 'sidebarAction', action: 'renameSession', sidebarKind: 'session', sidebarId: child.id });
  await receive({ type: 'sidebarAction', action: 'deleteFolder', sidebarKind: 'session', sidebarId: session.id });
  await receive({ type: 'sidebarAction', action: 'drop', sidebarKind: 'session', sidebarId: session.id, folderId: folder.id });
  assert.deepEqual(calls, [['open', session.id], ['move', session.id, folder.id]], 'only valid item actions are dispatched');
  assert.deepEqual(sent.at(-1).agents.map((agent) => agent.name), ['Build', 'Plan']);
  await receive({ type: 'selectAgent', agent: 'plan' });
  assert.equal(sent.at(-1).selected, 'plan');
  provider.setDefaultAgent = async () => { throw new Error('Unavailable'); };
  await receive({ type: 'selectAgent', agent: 'missing' });
  assert.equal(sent.at(-1).selected, 'plan');
  assert.equal(sent.at(-1).error, 'Unavailable');
  const manifest = require('../package.json');
  assert.deepEqual(manifest.contributes.views.opencode.map(({ id, type }) => ({ id, type })),
    [{ id: 'opencode.sessions', type: 'webview' }], 'the footer belongs to the existing Sessions view, not a second view');
  console.log('SESSION DEFAULTS OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const { SessionEditors } = require('../src/session-editor');
const { SessionClient } = require('../src/session-client');

function fixture(store = new Map()) {
  const data = { opens: [], panels: [], lookups: [], store };
  const context = { subscriptions: [], workspaceState: {
    get: (key, fallback) => structuredClone(store.get(key) ?? fallback),
    update: async (key, value) => { store.set(key, structuredClone(value)); },
  } };
  const vscode = {
    Uri: { from: (value) => ({ authority: '', query: '', fragment: '', ...value }) },
    ViewColumn: { Active: -1 },
    window: {
      tabGroups: { all: [] },
      registerCustomEditorProvider(type, provider, options) {
        data.registration = { type, provider, options };
        return { dispose() {} };
      },
    },
    commands: { async executeCommand(command, uri, type, options) {
      data.opens.push({ command, uri, type, options });
      const document = await data.registration.provider.openCustomDocument(uri);
      const listeners = [];
      const panel = { title: `${document.id}.opencode-session`,
        onDidDispose: (listener) => { listeners.push(listener); },
        dispose() { listeners.forEach((listener) => listener()); document.dispose(); },
      };
      await data.registration.provider.resolveCustomEditor(document, panel, { isCancellationRequested: false });
    } },
  };
  const api = { async getSession(id) {
    data.lookups.push(id);
    if (id === 'ses_deleted') throw new Error('Session not found');
    return { id, title: 'Recovered title', location: { directory: '/server/directory' } };
  } };
  const editors = new SessionEditors({ vscode, context, api,
    createPanel(options) { data.panels.push(options); },
  });
  return { ...data, editors, vscode, api, data };
}

(async () => {
  const f = fixture();
  const manifest = require('../package.json');
  const contribution = manifest.contributes.customEditors.find((item) => item.viewType === f.data.registration.type);
  assert.deepEqual(contribution.selector, [
    { filenamePattern: '*.opencode-session' }, { filenamePattern: '**/*.opencode-session/*' },
  ]);
  assert.equal(contribution.priority, 'option');
  assert.deepEqual(f.data.registration.options, {
    webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false,
  });

  await f.editors.open(null, '/work/кириллица # ?');
  const first = f.panels[0];
  const uri = f.opens[0].uri;
  assert.equal(first.sessionId, null);
  assert.match(first.newSessionId, /^ses_[a-f0-9]{32}$/);
  assert.equal(uri.path, `/${first.newSessionId}.opencode-session/New Session`);
  assert.equal(f.opens[0].command, 'vscode.openWith');
  assert.equal(f.opens[0].options.preview, false);
  assert.equal(first.cwd, '/work/кириллица # ?');

  // Closing before ready and restarting the extension must reserve the SAME ID.
  first.panel.dispose();
  const restart = fixture(f.store);
  const doc = await restart.editors.openCustomDocument(uri);
  const panel = { title: 'New Session', onDidDispose() {}, reveal() {} };
  await restart.editors.resolveCustomEditor(doc, panel, { isCancellationRequested: false });
  assert.equal(restart.panels[0].newSessionId, first.newSessionId);
  assert.deepEqual(restart.lookups, [], 'a pending tab does not need an existing server session');

  // Verify the reserved ID reaches the server and that lost responses do not
  // cause a fresh session/default-model selection on retry.
  const requests = [];
  let lost = false;
  const client = new SessionClient({ cwd: first.cwd, api: {
    async getConfig() { return []; },
    async listAgents() { return []; },
    async _request(method, path, body) {
      requests.push({ method, path, body });
      if (lost) throw new Error('Lost response');
      return { data: { id: body.id } };
    },
    async getSession(id) { return { id }; },
  } });
  const loads = [];
  client.loadSession = async (id) => { loads.push(id); };
  await client.newSession('review', first.newSessionId);
  lost = true;
  await client.newSession('review', first.newSessionId);
  assert.deepEqual(loads, [first.newSessionId, first.newSessionId]);
  assert.deepEqual(requests[0], { method: 'POST', path: '/api/session', body: {
    id: first.newSessionId, location: { directory: first.cwd }, agent: 'review',
  } });
  assert.deepEqual(requests[1], requests[0]);

  await restart.editors.sessionCreated(first.newSessionId);
  const restored = fixture(f.store);
  const restoredDoc = await restored.editors.openCustomDocument(uri);
  await restored.editors.resolveCustomEditor(restoredDoc, panel, { isCancellationRequested: false });
  assert.equal(restored.panels[0].sessionId, first.newSessionId);
  assert.equal(restored.panels[0].newSessionId, undefined, 'closed sessions are loaded, never re-created');
  await restored.editors.resolveCustomEditor(restoredDoc, panel, { isCancellationRequested: true });
  assert.equal(restored.panels.length, 1, 'cancelled resolves do not create clients');

  restored.vscode.window.tabGroups.all = [{ viewColumn: 3, tabs: [
    { input: { viewType: 'opencode.sessionEditor', uri } },
  ] }];
  await restored.editors.open(first.newSessionId, '/moved', 'Renamed');
  assert.deepEqual(restored.opens[0].uri, uri, 'rename/move keep the native editor identity');
  assert.equal(restored.opens[0].options.viewColumn, 3, 'reuse the unresolved tab in its original group');
  assert.equal(restored.panels[1].title, 'Renamed');
  assert.equal(restored.panels[1].cwd, '/moved');

  const external = { ...uri, path: '/ses_external.opencode-session' };
  const externalDoc = await restored.editors.openCustomDocument(external);
  await restored.editors.resolveCustomEditor(externalDoc, panel, { isCancellationRequested: false });
  assert.equal(restored.panels[2].cwd, '/server/directory');
  assert.equal(restored.panels[2].sessionId, 'ses_external');
  assert.equal(restored.panels[2].title, 'Recovered title');
  await assert.rejects(restored.editors.openCustomDocument({ ...uri, scheme: 'file' }), /Invalid/);
  await assert.rejects(restored.editors.openCustomDocument({ ...uri, path: '/bad.opencode-session' }), /Invalid/);
  await assert.rejects(restored.editors.openCustomDocument({ ...uri, path: '/ses_deleted.opencode-session' }), /not found/);

  const named = fixture();
  await named.editors.open('ses_named', '/work', 'Название / путь \\ # ?');
  const namedUri = named.opens[0].uri;
  assert.equal(namedUri.path, '/ses_named.opencode-session/Название   путь   # ?');
  assert.equal(named.panels[0].sessionId, 'ses_named');
  named.panels[0].panel.title = 'Changed title';
  named.panels[0].panel.dispose();
  const namedRestart = fixture(named.store);
  const namedDoc = await namedRestart.editors.openCustomDocument(namedUri);
  await namedRestart.editors.resolveCustomEditor(namedDoc, panel, { isCancellationRequested: false });
  assert.equal(namedRestart.panels[0].title, 'Changed title', 'persist titles across extension restarts');
  await namedRestart.editors.open('ses_named', '/work', 'Latest name');
  assert.equal(namedRestart.opens[0].uri.path, '/ses_named.opencode-session/Latest name');
  await namedRestart.editors.open('ses_external', '/work');
  assert.equal(namedRestart.opens[1].uri.path, '/ses_external.opencode-session/Recovered title');
  const legacy = { ...uri, path: '/ses_legacy.opencode-session' };
  namedRestart.vscode.window.tabGroups.all = [{ viewColumn: 2, tabs: [
    { input: { viewType: 'opencode.sessionEditor', uri: legacy } },
  ] }];
  await namedRestart.editors.open('ses_legacy', '/work', 'Legacy title');
  assert.deepEqual(namedRestart.opens[2].uri, legacy, 'reuse unresolved legacy tabs');
  await assert.rejects(namedRestart.editors.openCustomDocument({ ...uri,
    path: '/ses_named.opencode-session/title/extra' }), /Invalid/);

  const duplicate = fixture();
  await duplicate.editors.open('ses_duplicate', '/work', 'Current name');
  let revealed = false;
  duplicate.panels[0].panel.reveal = () => { revealed = true; };
  const oldDoc = await duplicate.editors.openCustomDocument({ ...uri,
    path: '/ses_duplicate.opencode-session/Old name' });
  let disposed = false;
  await duplicate.editors.resolveCustomEditor(oldDoc, { dispose() { disposed = true; } },
    { isCancellationRequested: false });
  assert.equal(duplicate.panels.length, 1, 'native reopen of an old title must not create a second client');
  assert.ok(revealed && disposed, 'reveal the live editor and close the duplicate resource');

  console.log('SESSION EDITOR OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

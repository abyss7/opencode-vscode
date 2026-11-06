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
      registerCustomEditorProvider(type, provider, options) {
        data.registration = { type, provider, options };
        return { dispose() {} };
      },
      registerWebviewPanelSerializer(type, serializer) {
        assert.equal(type, 'opencode.session');
        data.serializer = serializer;
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
  const editors = new SessionEditors({ vscode, context, api, getCwd: () => '/fallback',
    createPanel(options) { data.panels.push(options); },
  });
  return { ...data, editors, vscode, api, data };
}

(async () => {
  const f = fixture();
  const manifest = require('../package.json');
  const contribution = manifest.contributes.customEditors.find((item) => item.viewType === f.data.registration.type);
  assert.deepEqual(contribution.selector, [{ filenamePattern: '*.opencode-session' }]);
  assert.equal(contribution.priority, 'option');
  assert.deepEqual(f.data.registration.options, {
    webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false,
  });

  await f.editors.open(null, '/work/кириллица # ?');
  const first = f.panels[0];
  const uri = f.opens[0].uri;
  assert.equal(first.sessionId, null);
  assert.match(first.newSessionId, /^ses_[a-f0-9]{32}$/);
  assert.equal(uri.path, `/${first.newSessionId}.opencode-session`);
  assert.equal(f.opens[0].command, 'vscode.openWith');
  assert.equal(f.opens[0].options.preview, false);
  assert.equal(first.cwd, '/work/кириллица # ?');

  // Closing before ready and restarting the extension must reserve the SAME ID.
  first.panel.dispose();
  const restart = fixture(f.store);
  const doc = await restart.editors.openCustomDocument(uri);
  const panel = { title: 'New Session', onDidDispose() {} };
  await restart.editors.resolveCustomEditor(doc, panel, { isCancellationRequested: false });
  assert.equal(restart.panels[0].newSessionId, first.newSessionId);
  assert.deepEqual(restart.lookups, [], 'a pending tab does not need an existing server session');

  // Verify the reserved ID reaches the server and that lost responses do not
  // cause a fresh session/default-model selection on retry.
  const requests = [];
  let lost = false;
  const client = new SessionClient({ cwd: first.cwd, api: {
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

  await restored.editors.open(first.newSessionId, '/moved', 'Renamed');
  assert.deepEqual(restored.opens[0].uri, uri, 'rename/move keep the native editor identity');
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

  // Compatibility serializer transfers saved webview state and placement, then
  // disposes the old panel only once its custom editor has opened successfully.
  const migration = fixture();
  let disposed = false;
  const legacy = { title: 'Previous tab', active: false, viewColumn: 3,
    dispose() { disposed = true; } };
  const state = { sessionId: 'ses_legacy', cwd: '/old', viewport: { top: 100 },
    artifacts: { reading: true }, submissions: [{ id: 'msg_pending', text: 'Продолжить' }] };
  await migration.data.serializer.deserializeWebviewPanel(legacy, state);
  assert.ok(disposed);
  assert.deepEqual(migration.panels[0].initialState, state);
  assert.equal(migration.panels[0].sessionId, 'ses_legacy');
  assert.equal(migration.panels[0].title, 'Previous tab');
  assert.deepEqual(migration.opens[0].options, { viewColumn: 3, preserveFocus: true, preview: false });
  assert.equal(migration.editors.initialStates.size, 0);

  disposed = false;
  migration.vscode.commands.executeCommand = async () => { throw new Error('Cannot open editor'); };
  await assert.rejects(migration.data.serializer.deserializeWebviewPanel(legacy, state), /Cannot open/);
  assert.equal(disposed, false, 'a failed migration must not close the old tab');

  console.log('SESSION EDITOR OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

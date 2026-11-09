'use strict';

const assert = require('node:assert/strict');
const { SessionEditors } = require('../src/session-editor');
const { SessionClient } = require('../src/session-client');

function fixture(store = new Map()) {
  const data = { opens: [], panels: [], lookups: [], warnings: [], closes: [], store };
  const context = { subscriptions: [], workspaceState: {
    get: (key, fallback) => structuredClone(store.get(key) ?? fallback),
    update: async (key, value) => { store.set(key, structuredClone(value)); },
  } };
  const windowApi = {
    tabGroups: { all: [], onDidChangeTabs(listener) {
      data.onTabsChanged = listener;
      return { dispose() {} };
    }, onDidChangeTabGroups(listener) {
      data.onGroupsChanged = listener;
      return { dispose() {} };
    }, async close(tab) {
      data.closes.push(tab);
      const group = this.all.find((item) => item.tabs.includes(tab));
      if (group) group.tabs = group.tabs.filter((item) => item !== tab);
      if (this.activeTabGroup?.activeTab === tab) this.activeTabGroup.activeTab = null;
      return true;
    } },
    async showWarningMessage(...args) {
      data.warnings.push(args);
      data.onWarning?.();
      return data.choice;
    },
    registerCustomEditorProvider(type, provider, options) {
      data.registration = { type, provider, options };
      return { dispose() {} };
    },
  };
  const vscode = {
    Uri: { from: (value) => ({ authority: '', query: '', fragment: '', ...value }) },
    ViewColumn: { Active: -1 },
    window: windowApi,
    commands: { async executeCommand(command, uri, type, options) {
       data.opens.push({ command, uri, type, options });
       if (data.skipResolveOnce) { data.skipResolveOnce = false; return; }
       const document = await data.registration.provider.openCustomDocument(uri);
      const listeners = [];
      const panel = { title: `${document.id}.opencode-session`,
        onDidDispose: (listener) => { listeners.push(listener); },
        dispose() { listeners.forEach((listener) => listener()); document.dispose(); },
      };
      await data.registration.provider.resolveCustomEditor(document, panel, { isCancellationRequested: false });
      if (data.trackTabs) {
        const group = windowApi.tabGroups.all.find((item) => item.viewColumn === options?.viewColumn);
        if (group && !group.tabs.some((entry) => entry.input?.uri?.path === uri.path)) {
          group.tabs.push({ input: { viewType: type, uri } });
        }
      }
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
  await named.editors.open('ses_named', '/work', 'Название / путь \\ # ?', { archived: true });
  await named.editors.setArchived('ses_named', true, { archiveFinalizing: true });
  const namedUri = named.opens[0].uri;
  assert.equal(namedUri.path, '/ses_named.opencode-session/Название   путь   # ?');
  assert.equal(named.panels[0].sessionId, 'ses_named');
  assert.equal(named.panels[0].archived, true);
  assert.equal(named.editors.records.ses_named.archiveFinalizing, true);
  const finalizingRestart = fixture(named.store);
  const finalizingDoc = await finalizingRestart.editors.openCustomDocument(namedUri);
  await finalizingRestart.editors.resolveCustomEditor(finalizingDoc, panel, { isCancellationRequested: false });
  assert.equal(finalizingRestart.panels[0].archiveFinalizing, true,
    'persist finalization while the extension is restarted');
  await named.editors.setArchived('ses_named', false);
  named.panels[0].panel.title = 'Changed title';
  named.panels[0].panel.dispose();
  const namedRestart = fixture(named.store);
  const namedDoc = await namedRestart.editors.openCustomDocument(namedUri);
  await namedRestart.editors.resolveCustomEditor(namedDoc, panel, { isCancellationRequested: false });
  assert.equal(namedRestart.panels[0].title, 'Changed title', 'persist titles across extension restarts');
  assert.equal(namedRestart.panels[0].archived, false, 'persist restored state across extension restarts');
  assert.equal(namedRestart.panels[0].archiveFinalizing, false, 'restoring clears finalization state');
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

  const orphan = fixture();
  const orphanUri = { ...uri, path: '/ses_orphan.opencode-session/Old title' };
  const orphanTab = { input: { viewType: 'opencode.sessionEditor', uri: orphanUri } };
  orphan.vscode.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: orphanTab };
  orphan.data.skipResolveOnce = true;
  orphan.data.choice = 'Reconnect tab';
  await orphan.editors.recoverActiveTab();
  assert.equal(orphan.opens.length, 2, 'try non-destructive reopen before closing a stale tab');
  assert.deepEqual(orphan.closes, [orphanTab], 'only close after explicit confirmation');
  assert.equal(orphan.panels[0].sessionId, 'ses_orphan', 'reconnect the original session, not a new one');
  assert.deepEqual(orphan.opens.map((entry) => entry.uri), [orphanUri, orphanUri]);
  assert.match(orphan.warnings[0][0], /unsent draft/);

  const declined = fixture();
  const declinedTab = { input: { viewType: 'opencode.sessionEditor', uri: orphanUri } };
  declined.vscode.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: declinedTab };
  declined.data.skipResolveOnce = true;
  await declined.editors.recoverActiveTab();
  assert.equal(declined.closes.length, 0, 'dismissal preserves the tab and its draft');
  await declined.editors.recoverActiveTab();
  assert.equal(declined.warnings.length, 1, 'do not repeatedly interrupt a focused tab');

  const switched = fixture();
  switched.vscode.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: declinedTab };
  switched.data.skipResolveOnce = true;
  switched.data.choice = 'Reconnect tab';
  switched.data.onWarning = () => { switched.vscode.window.tabGroups.activeTabGroup.activeTab = null; };
  await switched.editors.recoverActiveTab();
  assert.equal(switched.closes.length, 0, 'confirmation cannot close a tab after focus moved elsewhere');

  const resolved = fixture();
  resolved.vscode.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: declinedTab };
  await resolved.editors.recoverActiveTab();
  assert.equal(resolved.closes.length, 0, 'native resolution must never close the old tab');
  assert.equal(resolved.warnings.length, 0);
  assert.equal(resolved.panels[0].sessionId, 'ses_orphan');

  const silent = fixture();
  await silent.editors.open('ses_silent', '/work');
  const silentUri = silent.opens[0].uri;
  const silentTab = { input: { viewType: 'opencode.sessionEditor', uri: silentUri } };
  silent.vscode.window.tabGroups.activeTabGroup = { viewColumn: 3, activeTab: silentTab };
  silent.editors.liveEditors.get('ses_silent').sessionPanel = { awaitingWebview: true };
  silent.data.skipResolveOnce = true;
  silent.data.choice = 'Reconnect tab';
  await silent.editors.recoverActiveTab();
  assert.deepEqual(silent.closes, [silentTab], 'also recover a resolved panel whose webview never became ready');
  assert.equal(silent.panels.at(-1).sessionId, 'ses_silent');

  const healthy = fixture();
  await healthy.editors.open('ses_healthy', '/work');
  healthy.vscode.window.tabGroups.activeTabGroup = { viewColumn: 3, activeTab: {
    input: { viewType: 'opencode.sessionEditor', uri: healthy.opens[0].uri },
  } };
  healthy.editors.liveEditors.get('ses_healthy').sessionPanel = { awaitingWebview: false };
  await healthy.editors.recoverActiveTab();
  assert.equal(healthy.opens.length, 1, 'never touch an already attached tab');

  const activated = fixture();
  activated.vscode.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: declinedTab };
  activated.onTabsChanged();
  await new Promise((resolve) => setTimeout(resolve, 1650));
  assert.equal(activated.panels[0].sessionId, 'ses_orphan', 'selecting a restored tab reconnects it');
  assert.equal(activated.closes.length, 0);

  // A restored background tab keeps the basename of the resource it was opened
  // with. Serving the latest title replaces only the tab label, not the session.
  const labels = fixture();
  await labels.editors.open('ses_stale', '/work', 'New Session');
  const staleUri = labels.opens[0].uri;
  const labelsRestart = fixture(labels.store);
  const staleTab = { input: { viewType: 'opencode.sessionEditor', uri: staleUri } };
  const keptTab = { input: { viewType: 'opencode.sessionEditor', uri: {
    scheme: 'opencode-session', authority: '', query: '', fragment: '',
    path: '/ses_kept.opencode-session/Kept title',
  } } };
  labelsRestart.vscode.window.tabGroups.all = [
    { viewColumn: 3, activeTab: keptTab, tabs: [staleTab, keptTab] },
  ];
  labelsRestart.data.trackTabs = true;
  await labelsRestart.editors.refreshTabTitles();
  assert.equal(labelsRestart.panels.length, 1, 'the refreshed tab is opened');
  assert.equal(labelsRestart.opens[0].uri.path,
    '/ses_stale.opencode-session/Recovered title', 'the tab label uses the current title');
  assert.equal(labelsRestart.opens[0].options.background, true,
    'a background tab must not replace the visible editor');
  assert.deepEqual(labelsRestart.closes, [staleTab], 'only the stale tab is closed');
  assert.equal(labelsRestart.editors.records.ses_stale.title, 'Recovered title',
    'the fetched title is remembered for the next restart');
  assert.equal(labelsRestart.lookups.length, 1, 'only tabs with a placeholder title ask the server');

  const lostOpen = fixture(labels.store);
  const lostTab = { input: { viewType: 'opencode.sessionEditor', uri: staleUri } };
  lostOpen.vscode.window.tabGroups.all = [
    { viewColumn: 3, activeTab: keptTab, tabs: [lostTab, keptTab] },
  ];
  lostOpen.data.skipResolveOnce = true;
  await lostOpen.editors.refreshTabTitles();
  assert.deepEqual(lostOpen.closes, [],
    'keep the old tab when the replacement did not open');

  const alreadyLive = fixture();
  await alreadyLive.editors.open('ses_open', '/work', 'New Session');
  const liveTab = { input: { viewType: 'opencode.sessionEditor', uri: alreadyLive.opens[0].uri } };
  alreadyLive.vscode.window.tabGroups.all = [
    { viewColumn: 1, activeTab: keptTab, tabs: [liveTab, keptTab] },
  ];
  await alreadyLive.editors.refreshTabTitles();
  assert.equal(alreadyLive.opens.length, 1, 'a resolved tab already shows the live panel title');

  const pendingTitle = fixture();
  await pendingTitle.editors.open(null, '/work');
  const pendingTab = { input: { viewType: 'opencode.sessionEditor', uri: pendingTitle.opens[0].uri } };
  pendingTitle.vscode.window.tabGroups.all = [
    { viewColumn: 1, activeTab: keptTab, tabs: [pendingTab, keptTab] },
  ];
  await pendingTitle.editors.refreshTabTitles();
  assert.equal(pendingTitle.opens.length, 1, 'a tab waiting for its first session keeps its label');
  assert.deepEqual(pendingTitle.lookups, [], 'a pending tab never asks the server for a title');

  const titled = fixture();
  await titled.editors.open('ses_titled', '/work', 'First name');
  await titled.editors.setTitle('ses_titled', 'Second name');
  const titledRestart = fixture(titled.store);
  assert.equal(titledRestart.editors.records.ses_titled.title, 'Second name',
    'titles that arrive after opening survive a restart');
  await titled.editors.setTitle('ses_unknown', 'Ignored');
  assert.equal(titled.editors.records.ses_unknown, undefined,
    'do not invent records for closed sessions');

  console.log('SESSION EDITOR OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

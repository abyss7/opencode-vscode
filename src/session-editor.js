'use strict';

const { randomUUID } = require('node:crypto');

const VIEW_TYPE = 'opencode.sessionEditor';
const SCHEME = 'opencode-session';
const STATE_KEY = 'opencode.sessionEditors';

// The basename is a readable title even while VS Code leaves an editor unresolved.
// Session identity lives in the parent directory; the title is a snapshot that
// VS Code only refreshes from a live panel. Restored background editors never
// create a panel, so their stale basenames are replaced after startup (see
// refreshTabTitles). Pending IDs are reserved before opening a new tab and
// acknowledged after server creation. Reopening a tab must never create a second
// session (or resurrect a deleted one).
class SessionEditors {
  constructor({ vscode, context, api, createPanel, log = () => {} }) {
    this.vscode = vscode;
    this.state = context.workspaceState;
    this.api = api;
    this.createPanel = createPanel;
    this.log = log;
    this.records = { ...this.state.get(STATE_KEY, {}) };
    this.titles = new Map();
    this.liveEditors = new Map();
    this.orphanAttempt = null;
    this.orphanNotified = null;
    this.orphanTimer = null;
    this.disposed = false;
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }));
    const tabs = vscode.window.tabGroups;
    if (tabs?.onDidChangeTabs) context.subscriptions.push(tabs.onDidChangeTabs(() => this.scheduleOrphanCheck()));
    if (tabs?.onDidChangeTabGroups) context.subscriptions.push(tabs.onDidChangeTabGroups(() => this.scheduleOrphanCheck()));
    context.subscriptions.push({ dispose: () => {
      this.disposed = true;
      clearTimeout(this.orphanTimer);
    } });
    this.scheduleOrphanCheck();
  }

  scheduleOrphanCheck() {
    if (this.disposed || !this.vscode.window.tabGroups?.activeTabGroup) return;
    clearTimeout(this.orphanTimer);
    // VS Code can report an active restored tab before resolving its custom editor.
    const tab = this.vscode.window.tabGroups.activeTabGroup.activeTab;
    const id = tab?.input?.viewType === VIEW_TYPE && this.sessionId(tab.input.uri);
    const awaitingWebview = id && this.liveEditors.get(id)?.sessionPanel?.awaitingWebview;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      this.recoverActiveTab().catch((error) => this.log(`Cannot reconnect session tab: ${error.message}`));
    }, awaitingWebview ? 5000 : 1500);
    this.orphanTimer.unref?.();
  }

  isOrphaned(id) {
    const entry = this.liveEditors.get(id);
    return !entry || entry.sessionPanel?.awaitingWebview === true;
  }

  async recoverActiveTab() {
    const groups = this.vscode.window.tabGroups;
    const group = groups?.activeTabGroup;
    const tab = group?.activeTab;
    const id = tab?.input?.viewType === VIEW_TYPE && this.sessionId(tab.input.uri);
    if (!id || !this.isOrphaned(id)) {
      this.orphanNotified = null;
      return;
    }
    if (this.orphanAttempt || this.orphanNotified === id) return;
    const uri = tab.input.uri;
    this.orphanAttempt = id;
    const activeTab = () => groups.activeTabGroup?.activeTab;
    const stillActive = () => {
      const current = activeTab();
      return !this.disposed && current?.input?.viewType === VIEW_TYPE &&
        current.input.uri?.scheme === uri.scheme && current.input.uri?.path === uri.path &&
        this.isOrphaned(id);
    };
    try {
      this.log(`Session tab ${id} has no connected editor; trying to restore it`);
      // Reusing the exact resource may cause VS Code to resolve an old tab
      // without disposing its webview (and its unsent draft).
      await this.vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
        viewColumn: group.viewColumn, preview: false,
      });
      if (!stillActive()) {
        if (!this.isOrphaned(id)) this.log(`Session tab ${id} restored without closing`);
        return;
      }
      const entry = this.liveEditors.get(id);
      const delay = entry?.sessionPanel?.awaitingWebview
        ? Math.max(0, 5000 - (Date.now() - entry.resolvedAt)) : 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!stillActive()) return;

      this.orphanNotified = id;
      const reconnect = 'Reconnect tab';
      const choice = await this.vscode.window.showWarningMessage(
        'This OpenCode tab is no longer connected. Reconnecting closes its old view; any unsent draft in that view may be lost.',
        { modal: true }, reconnect
      );
      if (choice !== reconnect || !stillActive()) return;
      const column = groups.activeTabGroup.viewColumn;
      if (!await groups.close(activeTab())) return;
      await this.vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
        viewColumn: column, preview: false,
      });
      this.log(`Session tab ${id} reopened after confirmation`);
    } finally {
      this.orphanAttempt = null;
      const current = groups?.activeTabGroup?.activeTab;
      if (current?.input?.viewType === VIEW_TYPE && this.sessionId(current.input.uri) !== id) {
        this.scheduleOrphanCheck();
      }
    }
  }

  save() {
    return this.state.update(STATE_KEY, { ...this.records });
  }

  /**
   * Resource path for a session tab. VS Code labels an unresolved custom editor
   * by the basename of this path, so it mirrors the current title.
   */
  titlePath(id, title) {
    const basename = String(title || '').replace(/[\/\\\x00-\x1f\x7f]/g, ' ').trim();
    return `/${id}.opencode-session/${basename && !/^\.{1,2}$/.test(basename) ? basename : 'Session'}`;
  }

  /**
   * Remember a title that arrived from the server. The tab resource keeps its
   * opening snapshot; the record always holds the latest name for restore.
   */
  async setTitle(id, title) {
    if (!id || !title || !this.records[id]) return;
    if (this.records[id].title === title) return;
    this.records[id] = { ...this.records[id], title };
    this.titles.set(id, title);
    await this.save();
  }

  /**
   * A restored background editor never resolves, so VS Code only knows its
   * opening title snapshot. Replace such a tab with an equivalent inactive one
   * whose path carries the latest title; the visible tab of each group is left
   * to recoverActiveTab, which creates a real panel.
   */
  async refreshTabTitles() {
    if (this.disposed) return;
    for (const group of this.vscode.window.tabGroups?.all || []) {
      const active = group.activeTab;
      for (const tab of group.tabs) {
        if (this.disposed) return;
        if (tab === active || tab.input?.viewType !== VIEW_TYPE) continue;
        const id = this.sessionId(tab.input.uri);
        if (!id || this.liveEditors.has(id) || this.records[id]?.pending) continue;
        const title = await this.sessionTitle(id, true);
        if (!title) continue;
        const path = this.titlePath(id, title);
        if (tab.input.uri.path === path) continue;
        // The user may have selected the tab while the title was being read.
        const current = (this.vscode.window.tabGroups?.all || [])
          .find((item) => item.viewColumn === group.viewColumn);
        if (!current || current.activeTab === tab || this.liveEditors.has(id) ||
            !current.tabs.includes(tab)) continue;
        await this.vscode.commands.executeCommand('vscode.openWith',
          this.vscode.Uri.from({ scheme: SCHEME, path }), VIEW_TYPE, {
            viewColumn: group.viewColumn, preview: false, background: true,
          });
        await this.vscode.window.tabGroups.close(tab);
        this.log(`Refreshed the title of session tab ${id}`);
      }
    }
  }

  async sessionTitle(id, fresh = false) {
    if (!fresh) {
      const known = this.records[id]?.title;
      if (known && known !== 'New Session') return known;
    }
    try {
      const session = await this.api.getSession(id);
      if (session?.title) {
        await this.setTitle(id, session.title);
        return session.title;
      }
    } catch (error) {
      this.log(`Cannot read the title of session ${id}: ${error.message}`);
    }
    return this.records[id]?.title;
  }

  async open(sessionId, cwd, title, options = {}) {
    const id = sessionId || `ses_${randomUUID().replaceAll('-', '')}`;
    if (!title && sessionId) title = (await this.api.getSession(id))?.title;
    title = title || this.records[id]?.title || 'New Session';
    this.records[id] = { ...this.records[id], cwd,
      title, ...(typeof options.archived === 'boolean' ? { archived: options.archived } : {}),
      ...(!sessionId ? { pending: true } : {}) };
    this.titles.set(id, title);
    await this.save();
    // Restored background editors may not have a panel yet. Reuse their exact
    // resource (including legacy URIs), regardless of a subsequent rename.
    const tab = (this.vscode.window.tabGroups?.all || []).flatMap((group) =>
      group.tabs.map((tab) => ({ tab, column: group.viewColumn })))
      .find(({ tab }) => tab.input?.viewType === VIEW_TYPE && this.sessionId(tab.input.uri) === id);
    const uri = tab?.tab.input.uri || this.vscode.Uri.from({
      scheme: SCHEME, path: this.titlePath(id, title),
    });
    await this.vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: tab?.column ?? this.vscode.ViewColumn.Active, preview: false,
    });
  }

  async sessionCreated(id) {
    if (!this.records[id]?.pending) return;
    const { pending, ...record } = this.records[id];
    this.records[id] = record;
    await this.save();
  }

  async setArchived(id, archived, options = {}) {
    if (!this.records[id]) return;
    const value = Boolean(archived);
    this.records[id] = { ...this.records[id], archived: value,
      ...(!value ? { archiveFinalizing: false } : {}),
      ...(typeof options.archiveFinalizing === 'boolean'
        ? { archiveFinalizing: options.archiveFinalizing } : {}) };
    await this.save();
  }

  async setArchiveFinalizing(id, finalizing) {
    if (!this.records[id]) return;
    this.records[id] = { ...this.records[id], archiveFinalizing: Boolean(finalizing) };
    await this.save();
  }

  sessionId(uri) {
    if (!uri || uri.scheme !== SCHEME || uri.authority || uri.query || uri.fragment) return;
    return /^\/(ses_[\w-]+)\.opencode-session(?:\/[^/]+)?$/.exec(uri.path)?.[1];
  }

  async openCustomDocument(uri) {
    const id = this.sessionId(uri);
    if (!id) {
      throw new Error('Invalid OpenCode session URI.');
    }
    if (!this.records[id]?.cwd) {
      const session = await this.api.getSession(id);
      const cwd = session?.location?.directory;
      if (!cwd) throw new Error('The OpenCode session has no working directory.');
      this.records[id] = { cwd, title: session.title };
      if (session.title) this.titles.set(id, session.title);
      await this.save();
    }
    return { uri, id, dispose() {} };
  }

  async resolveCustomEditor(document, panel, token) {
    if (token.isCancellationRequested) return;
    // Native reopen history can contain an older title URI for the same session.
    // VS Code deduplicates resources, not session IDs.
    const existing = this.liveEditors.get(document.id);
    if (existing && existing.uri.path !== document.uri.path) {
      existing.panel.reveal(existing.panel.viewColumn);
      panel.dispose();
      return;
    }
    const entry = { uri: document.uri, panel, resolvedAt: Date.now() };
    this.liveEditors.set(document.id, entry);
    if (this.orphanNotified === document.id) this.orphanNotified = null;
    const { cwd, pending, archived, archiveFinalizing } = this.records[document.id];
    // VS Code also persists the webview title when restoring an editor.
    const title = this.titles.get(document.id) || this.records[document.id].title ||
      (panel.title !== `${document.id}.opencode-session` ? panel.title : undefined);
    panel.onDidDispose(() => {
      if (this.liveEditors.get(document.id)?.panel === panel) this.liveEditors.delete(document.id);
      this.titles.set(document.id, panel.title);
      this.records[document.id] = { ...this.records[document.id], title: panel.title };
      void this.save();
    });
    entry.sessionPanel = this.createPanel({ panel, cwd, title,
      sessionId: pending ? null : document.id,
      newSessionId: pending ? document.id : undefined,
      archived: Boolean(archived),
      archiveFinalizing: Boolean(archiveFinalizing),
    });
    this.scheduleOrphanCheck();
  }
}

module.exports = { SessionEditors };

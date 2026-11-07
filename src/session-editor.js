'use strict';

const { randomUUID } = require('node:crypto');

const VIEW_TYPE = 'opencode.sessionEditor';
const SCHEME = 'opencode-session';
const STATE_KEY = 'opencode.sessionEditors';

// The basename is a readable title even while VS Code leaves an editor unresolved.
// Session identity lives in the parent directory; the title is an opening snapshot.
// Pending IDs are reserved before opening a new tab and acknowledged after server
// creation. Reopening a tab must never create a second session (or resurrect a
// deleted one).
class SessionEditors {
  constructor({ vscode, context, api, createPanel }) {
    this.vscode = vscode;
    this.state = context.workspaceState;
    this.api = api;
    this.createPanel = createPanel;
    this.records = { ...this.state.get(STATE_KEY, {}) };
    this.titles = new Map();
    this.liveEditors = new Map();
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }));
  }

  save() {
    return this.state.update(STATE_KEY, { ...this.records });
  }

  async open(sessionId, cwd, title) {
    const id = sessionId || `ses_${randomUUID().replaceAll('-', '')}`;
    if (!title && sessionId) title = (await this.api.getSession(id))?.title;
    title = title || this.records[id]?.title || 'New Session';
    this.records[id] = { ...this.records[id], cwd,
      title,
      ...(!sessionId ? { pending: true } : {}) };
    this.titles.set(id, title);
    await this.save();
    // Restored background editors may not have a panel yet. Reuse their exact
    // resource (including legacy URIs), regardless of a subsequent rename.
    const tab = (this.vscode.window.tabGroups?.all || []).flatMap((group) =>
      group.tabs.map((tab) => ({ tab, column: group.viewColumn })))
      .find(({ tab }) => tab.input?.viewType === VIEW_TYPE && this.sessionId(tab.input.uri) === id);
    const basename = title.replace(/[\/\\\x00-\x1f\x7f]/g, ' ').trim();
    const uri = tab?.tab.input.uri || this.vscode.Uri.from({
      scheme: SCHEME, path: `/${id}.opencode-session/${basename && !/^\.{1,2}$/.test(basename) ? basename : 'Session'}`,
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
    this.liveEditors.set(document.id, { uri: document.uri, panel });
    const { cwd, pending } = this.records[document.id];
    // VS Code also persists the webview title when restoring an editor.
    const title = this.titles.get(document.id) || this.records[document.id].title ||
      (panel.title !== `${document.id}.opencode-session` ? panel.title : undefined);
    panel.onDidDispose(() => {
      if (this.liveEditors.get(document.id)?.panel === panel) this.liveEditors.delete(document.id);
      this.titles.set(document.id, panel.title);
      this.records[document.id] = { ...this.records[document.id], title: panel.title };
      void this.save();
    });
    this.createPanel({ panel, cwd, title,
      sessionId: pending ? null : document.id,
      newSessionId: pending ? document.id : undefined,
    });
  }
}

module.exports = { SessionEditors };

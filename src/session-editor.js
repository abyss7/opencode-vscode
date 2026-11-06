'use strict';

const { randomUUID } = require('node:crypto');

const VIEW_TYPE = 'opencode.sessionEditor';
const SCHEME = 'opencode-session';
const STATE_KEY = 'opencode.sessionEditors';

// URI identity is only the session ID: titles and working directories can change.
// Pending IDs are reserved before opening a new tab and acknowledged after server
// creation. Reopening a tab must never create a second session (or resurrect a
// deleted one).
class SessionEditors {
  constructor({ vscode, context, api, getCwd, createPanel }) {
    this.vscode = vscode;
    this.state = context.workspaceState;
    this.api = api;
    this.getCwd = getCwd;
    this.createPanel = createPanel;
    this.records = { ...this.state.get(STATE_KEY, {}) };
    this.titles = new Map();
    this.initialStates = new Map();
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }));
    // Upgrade tabs saved by pre-custom-editor versions of the extension.
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('opencode.session', {
      deserializeWebviewPanel: async (panel, state) => {
        const cwd = state?.cwd || this.getCwd();
        if (!state?.sessionId || !cwd) { panel.dispose(); return; }
        this.initialStates.set(state.sessionId, state);
        try {
          await this.open(state.sessionId, cwd, panel.title, {
            viewColumn: panel.viewColumn, preserveFocus: !panel.active,
          });
          panel.dispose();
        } finally {
          this.initialStates.delete(state.sessionId);
        }
      },
    }));
  }

  save() {
    return this.state.update(STATE_KEY, { ...this.records });
  }

  async open(sessionId, cwd, title, options = {}) {
    const id = sessionId || `ses_${randomUUID().replaceAll('-', '')}`;
    this.records[id] = { ...this.records[id], cwd,
      ...(!sessionId ? { pending: true } : {}) };
    if (title) this.titles.set(id, title);
    await this.save();
    const uri = this.vscode.Uri.from({ scheme: SCHEME, path: `/${id}.opencode-session` });
    await this.vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: this.vscode.ViewColumn.Active, ...options, preview: false,
    });
  }

  async sessionCreated(id) {
    if (!this.records[id]?.pending) return;
    const { pending, ...record } = this.records[id];
    this.records[id] = record;
    await this.save();
  }

  async openCustomDocument(uri) {
    const match = /^\/(ses_[\w-]+)\.opencode-session$/.exec(uri.path);
    if (uri.scheme !== SCHEME || !match || uri.authority || uri.query || uri.fragment) {
      throw new Error('Invalid OpenCode session URI.');
    }
    const id = match[1];
    if (!this.records[id]?.cwd) {
      const session = await this.api.getSession(id);
      const cwd = session?.location?.directory;
      if (!cwd) throw new Error('The OpenCode session has no working directory.');
      this.records[id] = { cwd };
      if (session.title) this.titles.set(id, session.title);
      await this.save();
    }
    return { uri, id, dispose() {} };
  }

  async resolveCustomEditor(document, panel, token) {
    if (token.isCancellationRequested) return;
    const { cwd, pending } = this.records[document.id];
    // VS Code also persists the webview title when restoring an editor.
    const title = this.titles.get(document.id) ||
      (panel.title !== `${document.id}.opencode-session` ? panel.title : undefined);
    panel.onDidDispose(() => this.titles.set(document.id, panel.title));
    this.createPanel({ panel, cwd, title,
      sessionId: pending ? null : document.id,
      newSessionId: pending ? document.id : undefined,
      initialState: this.initialStates.get(document.id),
    });
  }
}

module.exports = { SessionEditors };

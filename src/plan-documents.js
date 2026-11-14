'use strict';

// Plan artifacts open in a dedicated, locked editor tab beside the chat
// instead of the generic artifacts panel. The tab renders the plan, lets the
// user tick tasks, and keeps the pending status changes until the next prompt
// attaches them as task data for the model.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { parseArtifact, PLAN_STATUSES } = require('./artifact-contract');

const PLAN_HTML_PATH = path.join(__dirname, '..', 'media', 'plan.html');

function taskStatuses(value) {
  const statuses = [];
  for (const phase of value.phases || []) {
    for (const task of phase.tasks || []) statuses.push(task);
  }
  return statuses;
}

class PlanDocuments {
  constructor(deps = {}) {
    this.vscode = deps.vscode || vscode;
    this.log = deps.log || (() => {});
    this.extensionUri = deps.extensionUri || null;
    this._plans = new Map();   // `${sessionId} ${id}` -> entry
    this._sessions = new Map(); // sessionId -> Set of entries
    this._titles = new Map();   // sessionId -> session title
    this._open = new Set();     // live webview panels
    this._column = null;        // shared (locked) column for plan tabs
    this._locked = false;
    this._disposed = false;
  }

  _key(sessionId, id) {
    return `${sessionId} ${id}`;
  }

  _entry(sessionId, id) {
    return this._plans.get(this._key(sessionId, id)) || null;
  }

  _autoOpen() {
    try {
      return this.vscode.workspace.getConfiguration('opencodeSessions').get('planTab', 'beside') !== 'manual';
    } catch {
      return true;
    }
  }

  /**
   * Registers an artifact version. Duplicate (id, version) pairs from history
   * replay are ignored. New versions absorb overlay entries they already
   * reflect and drop entries for removed tasks.
   */
  ingest(sessionId, source) {
    if (this._disposed || !sessionId || typeof source !== 'string') return false;
    let value;
    try {
      value = parseArtifact(source);
    } catch {
      return false;
    }
    if (value.kind !== 'plan') return false;
    const key = this._key(sessionId, value.id);
    let entry = this._plans.get(key);
    if (!entry) {
      entry = { key, sessionId, id: value.id, title: value.title, versions: new Map(), seen: new Set(),
        overlay: new Map(), dirty: new Set(), panel: null, dismissed: false };
      this._plans.set(key, entry);
      if (!this._sessions.has(sessionId)) this._sessions.set(sessionId, new Set());
      this._sessions.get(sessionId).add(entry);
    }
    if (entry.seen.has(value.version)) return false;
    entry.seen.add(value.version);
    entry.versions.set(value.version, value);
    entry.title = value.title;
    for (const [taskId, status] of [...entry.overlay]) {
      const task = taskStatuses(value).find((item) => item.id === taskId);
      if (!task || task.status === status) {
        entry.overlay.delete(taskId);
        entry.dirty.delete(taskId);
      }
    }
    if (entry.panel) {
      if (entry.panel.title !== value.title) entry.panel.title = value.title;
      this._pushPlan(entry);
    } else if (!entry.dismissed && this._autoOpen()) {
      this._openPanel(entry);
    }
    return true;
  }

  /** Opens (or brings back) the plan tab for an already ingested plan. */
  reveal(sessionId, id) {
    if (this._disposed) return false;
    const entry = this._entry(sessionId, id);
    if (!entry) return false;
    entry.dismissed = false;
    if (!entry.panel) this._openPanel(entry);
    else entry.panel.reveal(entry.panel.viewColumn, false);
    return true;
  }

  /**
   * Applies a user status change on top of the latest version. Setting the
   * status back to the artifact's own value reverts the pending change.
   */
  setStatus(sessionId, id, taskId, status) {
    if (this._disposed || !PLAN_STATUSES.has(status)) return false;
    const entry = this._entry(sessionId, id);
    if (!entry) return false;
    const latest = entry.versions.get(Math.max(...entry.versions.keys()));
    const task = taskStatuses(latest).find((item) => item.id === taskId);
    if (!task) return false;
    if (task.status === status) {
      entry.overlay.delete(taskId);
      entry.dirty.delete(taskId);
    } else {
      entry.overlay.set(taskId, status);
      entry.dirty.add(taskId);
    }
    this._pushState(entry);
    return true;
  }

  /** Drops all pending user changes for a plan. */
  reset(sessionId, id) {
    if (this._disposed) return false;
    const entry = this._entry(sessionId, id);
    if (!entry) return false;
    entry.overlay.clear();
    entry.dirty.clear();
    this._pushState(entry);
    return true;
  }

  /**
   * Takes the pending user changes for a session (once per prompt) in a
   * model-friendly shape ordered like the plan itself.
   */
  pendingUpdates(sessionId) {
    if (this._disposed || !sessionId) return null;
    const updates = [];
    for (const entry of this._sessions.get(sessionId) || []) {
      if (!entry.dirty.size) continue;
      const version = Math.max(...entry.versions.keys());
      const latest = entry.versions.get(version);
      const changes = [];
      for (const task of taskStatuses(latest)) {
        if (!entry.overlay.has(task.id)) continue;
        changes.push({ taskId: task.id, from: task.status, to: entry.overlay.get(task.id) });
      }
      if (!changes.length) continue;
      updates.push({ id: entry.id, title: entry.title, version, changes });
      entry.dirty.clear();
    }
    return updates.length ? updates : null;
  }

  setSessionTitle(sessionId, title) {
    if (!sessionId || !title || this._titles.get(sessionId) === title) return;
    this._titles.set(sessionId, title);
    for (const entry of this._sessions.get(sessionId) || []) this._pushState(entry);
  }

  /** Closes the plan tabs of a closed chat and forgets the session's plans. */
  closeSession(sessionId) {
    for (const entry of [...(this._sessions.get(sessionId) || [])]) {
      const panel = entry.panel;
      entry.panel = null;
      entry.dismissed = true;
      try {
        panel?.dispose();
      } catch {
        // The panel may already be disposed by VS Code.
      }
      this._plans.delete(entry.key);
    }
    this._sessions.delete(sessionId);
    this._titles.delete(sessionId);
  }

  dispose() {
    this._disposed = true;
    for (const entry of this._plans.values()) {
      try {
        entry.panel?.dispose();
      } catch {
        // Ignore.
      }
    }
    this._plans.clear();
    this._sessions.clear();
    this._titles.clear();
    this._open.clear();
  }

  _serialize(entry) {
    const latest = Math.max(...entry.versions.keys());
    return {
      type: 'plan',
      id: entry.id,
      title: entry.title,
      sessionTitle: this._titles.get(entry.sessionId) || '',
      latest,
      versions: [...entry.versions.keys()].sort((a, b) => a - b).map((version) => ({
        version,
        value: entry.versions.get(version),
      })),
      overlay: Object.fromEntries(entry.overlay),
      dirty: [...entry.dirty],
    };
  }

  _pushPlan(entry) {
    if (!entry.panel) return;
    entry.panel.webview.postMessage(this._serialize(entry)).then(undefined, () => {});
  }

  _pushState(entry) {
    if (!entry.panel) return;
    const data = this._serialize(entry);
    entry.panel.webview.postMessage({
      type: 'state', id: entry.id, latest: data.latest, overlay: data.overlay, dirty: data.dirty,
      sessionTitle: data.sessionTitle,
    }).then(undefined, () => {});
  }

  _openPanel(entry) {
    const options = { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true };
    if (this.extensionUri) {
      options.localResourceRoots = [this.vscode.Uri.joinPath(this.extensionUri, 'media')];
    }
    const panel = this.vscode.window.createWebviewPanel('opencode.plan', entry.title, {
      viewColumn: this._column ?? this.vscode.ViewColumn.Beside,
      preserveFocus: true,
    }, options);
    if (this.extensionUri) {
      panel.iconPath = this.vscode.Uri.joinPath(this.extensionUri, 'media', 'opencode.svg');
    }
    entry.panel = panel;
    entry.dismissed = false;
    this._open.add(panel);
    panel.webview.html = this._html(panel.webview);
    const messageListener = panel.webview.onDidReceiveMessage((message) => this._onPanelMessage(entry, message));
    const disposeListener = panel.onDidDispose(() => {
      if (entry.panel === panel) {
        entry.panel = null;
        entry.dismissed = true;
      }
      this._open.delete(panel);
      if (this._open.size === 0) {
        this._column = null;
        this._locked = false;
      }
      messageListener.dispose();
      disposeListener.dispose();
    });
    this._column = panel.viewColumn ?? this._column;
    this._lockGroup(panel);
  }

  // Keeps casual editor opens out of the plan split by locking its group.
  _lockGroup(panel) {
    if (this._locked) return;
    (async () => {
      try {
        panel.reveal(undefined, false);
        await this.vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        this._locked = true;
      } catch (error) {
        this.log(`Cannot lock the plan editor group: ${error.message}`);
      }
    })();
  }

  _onPanelMessage(entry, message) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        this._pushPlan(entry);
        break;
      case 'toggle':
        this.setStatus(entry.sessionId, entry.id, String(message.taskId || ''), String(message.status || ''));
        break;
      case 'reset':
        this.reset(entry.sessionId, entry.id);
        break;
      case 'export':
        this._export(message).catch((error) => this.log(`Plan export failed: ${error.message}`));
        break;
      default:
        this.log(`Unknown plan panel message: ${message.type}`);
    }
  }

  async _export(message) {
    if (typeof message.markdown !== 'string' || message.markdown.length > 1000000) return;
    const name = String(message.name || 'plan.md').replace(/[^\w.-]/g, '_');
    const uri = await this.vscode.window.showSaveDialog({
      title: `Export ${name}`, saveLabel: 'Export', filters: { Markdown: ['md'] },
    });
    if (uri) await this.vscode.workspace.fs.writeFile(uri, Buffer.from(message.markdown, 'utf8'));
  }

  _html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name) => String(webview.asWebviewUri(this.vscode.Uri.joinPath(this.extensionUri, 'media', name)));
    return fs
      .readFileSync(PLAN_HTML_PATH, 'utf-8')
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{styleUri}}', () => uri('plan.css'))
      .replace('{{scriptUri}}', () => uri('plan.js'));
  }
}

module.exports = { PlanDocuments };

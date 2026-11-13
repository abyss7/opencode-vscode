'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { agentLabel } = require('./agent-label');
const { sessionActivity } = require('./session-activity');

class SessionsSidebar {
  constructor(options) { Object.assign(this, options); this.sequence = 0; this.nodes = new Map(); }

  get visible() { return Boolean(this.view?.visible); }
  set description(value) { this.descriptionText = value; if (this.view) this.view.description = value; }

  resolveContext(context) {
    if (!context || typeof context.sidebarId !== 'string') return undefined;
    return this.nodes.get(`${context.sidebarKind}:${context.sidebarId}`);
  }

  tree() {
    this.nodes.clear();
    const serialize = (elements, seen = new Set()) => elements.map((element) => {
      if (element.kind === 'error') return { kind: 'error', id: 'error', name: element.message, children: [] };
      const kind = element.kind === 'folder' ? 'folder' : 'session';
      const key = `${kind}:${element.id}`;
      if (seen.has(key)) return null;
      this.nodes.set(key, element);
      const item = this.provider.getTreeItem(element);
      const actions = kind === 'folder' ? (element.system === 'custom' ? ['deleteFolder'] : [])
        : element.parentID ? ['openSession', 'deleteSession']
          : ['openSession', 'renameSession', 'moveSessionTo',
            item.contextValue === 'opencode.session.archived' ? 'restoreSession' : 'archiveSession', 'deleteSession'];
      const dated = kind === 'session' && !['running', 'queued', 'unconfirmed'].includes(sessionActivity(element));
      return { kind, id: element.id, name: item.label, description: dated ? '' : item.description || '',
        timestamp: dated ? element.time?.updated || element.time?.created || 0 : undefined,
        tooltip: item.tooltip || '', icon: item.iconPath?.id || 'comment-discussion', actions,
        archived: item.contextValue === 'opencode.session.archived', subagent: Boolean(element.parentID),
        custom: element.system === 'custom',
        children: serialize(this.provider.getChildren(element), new Set([...seen, key])) };
    }).filter(Boolean);
    return serialize(this.provider.getChildren());
  }

  async act(message) {
    if (message.action === 'retryConnection') return this.refresh();
    if (message.action === 'downloadOpenCode') {
      return this.vscode.env.openExternal(this.vscode.Uri.parse('https://opencode.ai/download'));
    }
    if (message.action === 'newSession' || message.action === 'showLog') return this.actions[message.action]();
    const element = this.resolveContext(message);
    if (!element) return;
    if (message.action === 'drop') {
      const folder = this.resolveContext({ sidebarKind: 'folder', sidebarId: message.folderId });
      if (element.kind !== 'folder' && folder?.kind === 'folder') return this.moveToFolder(element, folder.id);
      return;
    }
    const item = this.provider.getTreeItem(element);
    const allowed = element.kind === 'folder' ? (element.system === 'custom' ? ['deleteFolder'] : [])
      : element.parentID ? ['openSession', 'deleteSession']
        : ['openSession', 'renameSession', 'moveSessionTo',
          item.contextValue === 'opencode.session.archived' ? 'restoreSession' : 'archiveSession', 'deleteSession'];
    let action = message.action;
    if (action === 'menu') {
      const labels = { openSession: 'Open', renameSession: 'Rename', moveSessionTo: 'Move to…',
        archiveSession: 'Archive', restoreSession: 'Restore', deleteSession: 'Delete session…', deleteFolder: 'Delete folder…' };
      const selected = await this.vscode.window.showQuickPick(allowed.map((id) => ({ id, label: labels[id] })),
        { title: item.label });
      action = selected?.id;
    }
    if (allowed.includes(action)) return this.actions[action](element);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.description = this.descriptionText;
    const { vscode, extensionUri } = this;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
    const resource = (name) => view.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    view.webview.html = fs.readFileSync(path.join(__dirname, '../media/sessions-sidebar.html'), 'utf8')
      .replaceAll('{{cspSource}}', () => view.webview.cspSource)
      .replaceAll('{{nonce}}', () => nonce)
      .replaceAll('{{styleUri}}', () => resource('sessions-sidebar.css'))
      .replaceAll('{{scrollUri}}', () => resource('scroll.js'))
      .replaceAll('{{scriptUri}}', () => resource('sessions-sidebar.js'));
    view.onDidDispose(() => { if (this.view === view) this.view = null; });
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'ready') await this.refresh();
      if (message.type === 'selectAgent' && typeof message.agent === 'string') {
        try { await this.setDefaultAgent(message.agent); await this.refresh(); }
        catch (error) { await this.refresh(error.message); }
      }
      if (message.type === 'sidebarAction') {
        try { await this.act(message); }
        catch (error) { this.vscode.window.showErrorMessage(error.message); }
      }
    });
  }

  async refresh(errorMessage) {
    const sequence = ++this.sequence;
    const view = this.view;
    const cwd = this.getCwd();
    try {
      await this.provider.refresh();
      if (!view || this.view !== view || sequence !== this.sequence) return;
      const items = this.tree();
      await view.webview.postMessage({ type: 'sessions', items });
      if (items.some((item) => item.kind === 'error')) return;
      const selected = this.defaultAgent(cwd);
      const agents = cwd ? await this.api.listAgents(cwd) : [];
      if (this.view !== view || sequence !== this.sequence) return;
      const choices = agents.filter((agent) => !agent.hidden && ['primary', 'all'].includes(agent.mode))
        .map((agent) => ({ id: agent.id, name: agentLabel(agent.id, agent.name), description: agent.description || '' }));
      if (cwd && !choices.some((agent) => agent.id === selected)) choices.unshift({ id: selected, name: agentLabel(selected), description: 'Configured agent is currently unavailable' });
      await view.webview.postMessage({ type: 'sessionDefaults', selected, agents: choices,
        error: errorMessage || (cwd ? '' : 'Open a workspace folder to choose an agent.') });
    } catch (error) {
      this.log(`Failed to refresh session defaults: ${error.message}`);
      if (view && this.view === view && sequence === this.sequence) {
        await view.webview.postMessage({ type: 'connectionError', error: error.message });
      }
    }
  }
}

module.exports = { SessionsSidebar };

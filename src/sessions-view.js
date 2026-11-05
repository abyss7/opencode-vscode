'use strict';

const vscode = require('vscode');
const { UNGROUPED_ID, ARCHIVED_ID } = require('./session-folders');
const { sessionActivity, UNCONFIRMED_MESSAGE } = require('./session-activity');

function isBusy(session) {
  return sessionActivity(session) === 'running';
}

function isSubagent(session) {
  return Boolean(session && session.parentID);
}

function formatRelative(timestamp) {
  if (!timestamp) return '';
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function sessionTitle(session) {
  return (session && session.title) || 'Untitled';
}

function sessionTimestamp(session) {
  const time = (session && session.time) || {};
  return time.updated || time.created || 0;
}

function sortSessions(sessions) {
  return sessions
    .slice()
    .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildGroups(state, active, archived) {
  const folderNames = Array.isArray(state && state.folders) ? state.folders : [];
  const assignments = isPlainObject(state && state.assignments)
    ? state.assignments
    : {};
  const archivedSessions = sortSessions(Array.isArray(archived) ? archived : []);
  const archivedIds = new Set(archivedSessions.map((session) => session.id));
  const pools = new Map(folderNames.map((name) => [name, []]));
  const ungrouped = [];

  for (const session of Array.isArray(active) ? active : []) {
    if (!session || !session.id) continue;
    if (archivedIds.has(session.id)) continue;
    const folder = assignments[session.id];
    if (folder && pools.has(folder)) pools.get(folder).push(session);
    else ungrouped.push(session);
  }

  const sortedNames = folderNames
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return [
    {
      kind: 'folder',
      id: UNGROUPED_ID,
      name: 'Ungrouped',
      system: 'ungrouped',
      sessions: sortSessions(ungrouped),
    },
    ...sortedNames.map((name) => ({
      kind: 'folder',
      id: name,
      name,
      system: 'custom',
      sessions: sortSessions(pools.get(name) || []),
    })),
    {
      kind: 'folder',
      id: ARCHIVED_ID,
      name: 'Archived',
      system: 'archived',
      sessions: archivedSessions,
    },
  ];
}

class SessionsProvider {
  constructor(api, getCwd, log, folders) {
    this.api = api;
    this.getCwd = getCwd;
    this.log = log;
    this.folders = folders || null;
    this._groups = [];
    this._sessions = [];
    this._children = new Map();
    this._archivedIds = new Set();
    this._cwd = null;
    this._error = null;
    this._refreshSequence = 0;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }

  async refresh() {
    const sequence = ++this._refreshSequence;
    const cwd = this.getCwd();
    this._cwd = cwd;
    if (!cwd) {
      this._groups = [];
      this._sessions = [];
      this._archivedIds = new Set();
      this._error = null;
      this._onDidChangeTreeData.fire();
      return;
    }

    const [activeResult, archivedResult, subagentResult] = await Promise.allSettled([
      this.api.listSessions(cwd),
      this.api.listSessions(cwd, { archived: true }),
      typeof this.api.listSubagents === 'function'
        ? this.api.listSubagents(cwd)
        : Promise.resolve([]),
    ]);
    if (sequence !== this._refreshSequence) return;

    const active =
      activeResult.status === 'fulfilled' ? activeResult.value : [];
    const archived =
      archivedResult.status === 'fulfilled' ? archivedResult.value : [];
    const subagents =
      subagentResult.status === 'fulfilled' && Array.isArray(subagentResult.value)
        ? subagentResult.value
        : [];
    this._error =
      activeResult.status === 'rejected' ? activeResult.reason : null;
    if (this._error) {
      this.log(
        `Failed to load sessions: ${
          this._error.stack || this._error.message || this._error
        }`
      );
    }
    if (archivedResult.status === 'rejected') {
      const reason = archivedResult.reason;
      this.log(
        `Failed to load archived sessions: ${
          (reason && (reason.stack || reason.message)) || reason
        }`
      );
    }

    if (this._error) {
      this._groups = [];
      this._sessions = [];
      this._archivedIds = new Set();
      this._onDidChangeTreeData.fire();
      return;
    }

    this._sessions = [...active, ...archived];
    const children = new Map();
    for (const session of subagents) {
      const parentId = session && session.parentID;
      if (!parentId) continue;
      const list = children.get(parentId);
      if (list) list.push(session);
      else children.set(parentId, [session]);
    }
    for (const list of children.values()) sortSessions(list);
    this._children = children;
    // Only prune when the active list came back non-empty; a transiently empty
    // list (a race while the server starts) must not drop assignments.
    if (this.folders && active.length > 0) {
      this.folders.prune(
        cwd,
        this._sessions.map((session) => session.id)
      );
    }
    const state = this.folders ? this.folders.state(cwd) : null;
    this._groups = buildGroups(state, active, archived);
    this._archivedIds = new Set(archived.map((session) => session.id));
    this._onDidChangeTreeData.fire();
  }

  getChildren(element) {
    if (!element) {
      if (this._error) {
        return [
          { kind: 'error', message: String(this._error.message || this._error) },
        ];
      }
      return this._groups;
    }
    if (element.kind === 'folder') return element.sessions;
    const children = this._children.get(element.id);
    return Array.isArray(children) ? children : [];
  }

  errorTreeItem(element) {
    const item = new vscode.TreeItem('Failed to load sessions');
    item.description = 'open log';
    item.iconPath = new vscode.ThemeIcon(
      'error',
      new vscode.ThemeColor('problemsErrorIcon.foreground')
    );
    item.tooltip = element.message;
    item.command = { command: 'opencode.showLog', title: 'Show Log' };
    return item;
  }

  folderTreeItem(group) {
    const count = group.sessions.length;
    const item = new vscode.TreeItem(
      group.name,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = `folder:${group.id}`;
    item.description = count === 0 ? 'empty' : String(count);
    if (group.system === 'archived') {
      item.iconPath = new vscode.ThemeIcon('archive');
    } else if (group.system === 'ungrouped') {
      item.iconPath = new vscode.ThemeIcon('inbox');
    } else {
      item.iconPath = new vscode.ThemeIcon('folder');
    }
    item.contextValue =
      group.system === 'archived'
        ? 'opencode.folder.archived'
        : group.system === 'ungrouped'
          ? 'opencode.folder.ungrouped'
          : 'opencode.folder';
    item.tooltip = `${group.name} — ${
      count === 0 ? 'no sessions' : `${count} session${count === 1 ? '' : 's'}`
    }`;
    item.folder = group;
    return item;
  }

  sessionTreeItem(session) {
    const busy = isBusy(session);
    const unconfirmed = sessionActivity(session) === 'unconfirmed';
    const subagent = isSubagent(session);
    const children = this._children.get(session.id);
    const hasChildren = Array.isArray(children) && children.length > 0;
    const collapsible = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(sessionTitle(session), collapsible);
    item.id = session.id;
    if (busy) {
      item.description = 'working';
    } else if (unconfirmed) {
      item.description = 'execution unconfirmed';
    } else if (hasChildren) {
      item.description = `${children.length} sub-agent${children.length === 1 ? '' : 's'}`;
    } else {
      item.description = formatRelative(sessionTimestamp(session));
    }
    if (busy) {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (unconfirmed) {
      item.iconPath = new vscode.ThemeIcon('question');
    } else if (subagent) {
      item.iconPath = new vscode.ThemeIcon('server-process');
    } else {
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
    }
    item.contextValue = subagent
      ? 'opencode.session.subagent'
      : this._archivedIds.has(session.id)
        ? 'opencode.session.archived'
        : 'opencode.session';
    item.tooltip = [
      sessionTitle(session),
      unconfirmed ? UNCONFIRMED_MESSAGE : null,
      subagent ? 'Sub-agent' : null,
      `ID: ${session.id}`,
      session.location && session.location.directory
        ? `Folder: ${session.location.directory}`
        : null,
      this._archivedIds.has(session.id) ? 'Archived' : null,
      hasChildren
        ? `${children.length} sub-agent${children.length === 1 ? '' : 's'}`
        : null,
      session.time && session.time.updated
        ? `Updated: ${new Date(session.time.updated).toLocaleString()}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
    item.command = {
      command: 'opencode.openSession',
      title: 'Open Session',
      arguments: [session],
    };
    item.session = session;
    return item;
  }

  getTreeItem(element) {
    if (element && element.kind === 'folder') {
      return this.folderTreeItem(element);
    }
    if (element && element.kind === 'error') {
      return this.errorTreeItem(element);
    }
    return this.sessionTreeItem(element);
  }

  find(sessionId) {
    const direct = this._sessions.find((session) => session.id === sessionId);
    if (direct) return direct;
    for (const list of this._children.values()) {
      const child = list.find((session) => session.id === sessionId);
      if (child) return child;
    }
    return null;
  }

  folderChoices() {
    return this._groups.map((group) => ({
      folderId: group.id,
      label: group.name,
      system: group.system,
      description:
        group.system === 'archived'
          ? 'system folder'
          : group.system === 'ungrouped'
            ? 'default folder'
            : `${group.sessions.length} session${
                group.sessions.length === 1 ? '' : 's'
              }`,
    }));
  }

  folderIdOf(sessionId) {
    if (this._archivedIds.has(sessionId)) return ARCHIVED_ID;
    if (!this.folders || !this._cwd) return UNGROUPED_ID;
    return this.folders.folderOf(this._cwd, sessionId) || UNGROUPED_ID;
  }

  isArchived(sessionId) {
    return this._archivedIds.has(sessionId);
  }

  hasFolder(folderId) {
    return this._groups.some((group) => group.id === folderId);
  }

  async moveSession(sessionId, folderId) {
    const cwd = this._cwd;
    const target = String(folderId || '');
    if (!cwd || !sessionId || !this.hasFolder(target)) return false;

    const archived = target === ARCHIVED_ID;
    if (archived !== this.isArchived(sessionId)) {
      await this.api.updateSession(sessionId, { archived });
    }
    if (!archived && this.folders) {
      this.folders.assign(
        cwd,
        sessionId,
        target === UNGROUPED_ID ? null : target
      );
    }
    return true;
  }
}

module.exports = {
  SessionsProvider,
  buildGroups,
  formatRelative,
  isBusy,
  sessionTitle,
  sessionTimestamp,
};

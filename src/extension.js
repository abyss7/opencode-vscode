'use strict';

/**
 * @file Extension entry point (`activate` / `deactivate`).
 *
 * Wires core services (`OpenCodeApi`, `PermissionService`, `ArchiveService`,
 * `OpenCodeSync`, `PlanDocuments`, `SessionsProvider`, `SessionsSidebar`,
 * `SessionEditors`), session panel lifecycle, and workspace event listeners.
 * Interactive command handlers live in `./commands.js`.
 */

const path = require('node:path');
const vscode = require('vscode');
const { OpenCodeApi } = require('./api');
const { SessionsProvider } = require('./sessions-view');
const { SessionFolders } = require('./session-folders');
const { SessionPanel } = require('./session-panel');
const { SessionEditors } = require('./session-editor');
const { SessionDrafts } = require('./session-drafts');
const { PlanDocuments } = require('./plan-documents');
const { SessionContinuation } = require('./session-continuation');
const { OpenCodeSync } = require('./opencode-sync');
const { resolveCommand } = require('./util');
const { PermissionService } = require('./permission-service');
const { ArchiveService } = require('./archive-service');
const { SessionsSidebar } = require('./sessions-sidebar');
const { createCommandHandlers } = require('./commands');

const VIEW_ID = 'opencode.sessions';

function activate(context) {
  const output = vscode.window.createOutputChannel('OpenCode');
  const log = (message) => {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  };
  context.subscriptions.push(output);

  const getConfig = () => {
    const sessions = vscode.workspace.getConfiguration('opencodeSessions');
    const legacy = vscode.workspace.getConfiguration('opencode');
    const command = sessions.get('command', legacy.get('command', 'opencode'));
    const autoApprovePermissions = sessions.get(
      'autoApprovePermissions',
      legacy.get('autoApprovePermissions', 'ask')
    );
    return {
      command: resolveCommand(command || 'opencode'),
      autoApprovePermissions: autoApprovePermissions || 'ask',
    };
  };

  const api = new OpenCodeApi({ command: getConfig().command, log });
  const drafts = new SessionDrafts(
    context.globalStorageUri?.fsPath
      ? path.join(context.globalStorageUri.fsPath, 'composer-drafts') : null,
    log
  );
  const continuations = new SessionContinuation(
    context.globalStorageUri?.fsPath
      ? path.join(context.globalStorageUri.fsPath, 'continuations')
      : null
  );
  const permissions = new PermissionService({ vscode, api, command: getConfig().command, log });
  const archive = new ArchiveService({ api, command: getConfig().command, log });
  const sync = new OpenCodeSync({ vscode, command: getConfig().command, log });
  const planDocuments = new PlanDocuments({ vscode, extensionUri: context.extensionUri, log });
  context.subscriptions.push(sync, planDocuments);
  sync.start().catch((error) => {
    log(`Settings sync failed to start: ${error.stack || error.message}`);
  });

  function getActiveFileUri() {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document.uri.scheme === 'file' ? editor.document.uri : null;
  }

  function getCwd() {
    const foldersList = vscode.workspace.workspaceFolders;
    if (foldersList && foldersList.length > 0) {
      const activeUri = getActiveFileUri();
      if (activeUri && foldersList.length > 1) {
        const folder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (folder) return folder.uri.fsPath;
      }
      return foldersList[0].uri.fsPath;
    }
    const activeUri = getActiveFileUri();
    return activeUri ? path.dirname(activeUri.fsPath) : null;
  }

  function defaultAgent(cwd) {
    const uri = cwd ? vscode.Uri.file(cwd) : undefined;
    return (
      vscode.workspace.getConfiguration('opencodeSessions', uri).get('defaultAgent', '') ||
      vscode.workspace.getConfiguration('opencode', uri).get('default_agent', 'build') ||
      'build'
    );
  }

  const folders = new SessionFolders(context.globalState);
  const provider = new SessionsProvider(api, getCwd, log, folders);
  const panels = new Map();
  const allPanels = new Set();
  const archiveFinalizations = new Map();
  let sidebar = null;
  let editors = null;
  let refreshTimer = null;

  function updateViewDescription() {
    const cwd = getCwd();
    if (sidebar) sidebar.description = cwd ? path.basename(cwd) : undefined;
  }

  async function refreshSessions() {
    updateViewDescription();
    if (sidebar) await sidebar.refresh();
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshSessions();
    }, 300);
  }

  const emptySessionCleanup = new WeakSet();
  async function deleteEmptyClosedSession(panel) {
    const id = panel.sessionId;
    if (!id || !panel.deleteIfEmptyOnClose || panels.has(id) || emptySessionCleanup.has(panel)) return;
    emptySessionCleanup.add(panel);
    try {
      const session = await api.getSession(id);
      if (!session || session._activity !== 'idle') return;
      const messages = await api.listMessages(id, { limit: 1 });
      if (messages.length || panels.has(id) || !panel.deleteIfEmptyOnClose) return;
      await api.deleteSession(id);
      log(`Deleted empty session after closing its tab: ${id}`);
      scheduleRefresh();
    } catch (error) {
      log(`Cannot delete empty closed session ${id}: ${error.stack || error.message}`);
    }
  }

  async function setArchivedState(sessionId, archived, options = {}) {
    const panel = panels.get(sessionId);
    panel?.setArchived(archived);
    if (typeof options.archiveFinalizing === 'boolean') {
      panel?.setArchiveFinalizing(options.archiveFinalizing);
    }
    await editors.setArchived(sessionId, archived, options);
  }

  async function setArchiveFinalizing(sessionId, finalizing) {
    panels.get(sessionId)?.setArchiveFinalizing(finalizing);
    await editors.setArchiveFinalizing(sessionId, finalizing);
  }

  function trackArchiveFinalization(sessionId, cwd, completion, notify = true) {
    const marker = {};
    archiveFinalizations.set(sessionId, marker);
    void Promise.resolve(completion).then(
      async (result) => {
        if (archiveFinalizations.get(sessionId) !== marker) return;
        archiveFinalizations.delete(sessionId);
        await setArchiveFinalizing(sessionId, false);
        if (result?.state === 'failed') {
          const detail = result.error || 'Unknown error';
          log(`Archive finalization failed for ${sessionId}: ${detail}`);
          if (notify) vscode.window.showWarningMessage(`Session archived, but finalization failed: ${detail}`);
        }
        scheduleRefresh();
      },
      async (error) => {
        if (archiveFinalizations.get(sessionId) !== marker) return;
        archiveFinalizations.delete(sessionId);
        await setArchiveFinalizing(sessionId, false);
        log(`Archive finalization failed for ${sessionId}: ${error.stack || error.message}`);
        if (notify) vscode.window.showWarningMessage(`Session archived, but finalization failed: ${error.message}`);
      }
    );
  }

  async function beginArchive(sessionId, cwd) {
    const { finalization } = await archive.archive(sessionId, cwd);
    await setArchivedState(sessionId, true, { archiveFinalizing: true });
    trackArchiveFinalization(sessionId, cwd, finalization);
  }

  async function reconcileArchiveFinalization(sessionId, cwd) {
    if (archiveFinalizations.has(sessionId)) return;
    try {
      const state = await archive.getFinalization(sessionId, cwd);
      if (state?.state === 'pending') {
        await setArchiveFinalizing(sessionId, true);
        trackArchiveFinalization(
          sessionId,
          cwd,
          archive.waitForFinalization(sessionId, cwd, state),
          false
        );
      } else {
        await setArchiveFinalizing(sessionId, false);
      }
    } catch (error) {
      await setArchiveFinalizing(sessionId, false);
      log(`Cannot read archive finalization for ${sessionId}: ${error.message}`);
    }
  }

  const deps = {
    extensionUri: context.extensionUri,
    workspaceState: context.workspaceState,
    drafts,
    api,
    log,
    continuations,
    getConfig,
    permissions,
    archive,
    archiveSession: beginArchive,
    defaultAgent,
    onRecentModelsChanged(source) {
      for (const panel of allPanels) {
        if (panel !== source) panel.refreshRecentModels();
      }
    },
    openSession: (sessionId, cwd) => handlers.openSession(sessionId, cwd),
    planDocuments,
    async onSessionCreated(panel, sessionId, cwd) {
      log(`Session created: ${sessionId} (${cwd})`);
      if (!panel.disposed) {
        panels.set(sessionId, panel);
      }
      scheduleRefresh();
      await editors.sessionCreated(sessionId);
      // Creation can finish after the user has already closed the new tab.
      await deleteEmptyClosedSession(panel);
    },
    onSessionDisposed(panel) {
      allPanels.delete(panel);
      const id = panel.sessionId || panel.newSessionId;
      if (id && panels.get(id) === panel) {
        panels.delete(id);
      }
      void deleteEmptyClosedSession(panel);
    },
    onSessionChanged() {
      scheduleRefresh();
    },
    onSessionTitle(id, title) {
      return editors.setTitle(id, title).catch((error) =>
        log(`Cannot store session title ${id}: ${error.message}`)
      );
    },
  };

  editors = new SessionEditors({
    vscode,
    context,
    api,
    log,
    createPanel({ panel, title, ...options }) {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      };
      const sessionPanel = new SessionPanel({ panel, deps, ...options });
      if (title) sessionPanel.applyTitle(title);
      allPanels.add(sessionPanel);
      panels.set(options.sessionId || options.newSessionId, sessionPanel);
      if (options.sessionId && options.archived) {
        void reconcileArchiveFinalization(options.sessionId, options.cwd);
      }
      return sessionPanel;
    },
  });

  // Command handlers must be created AFTER `editors` exists: they receive it
  // through plain destructuring, which captures the value once (a getter in
  // the object literal would not help). Everything else they capture is
  // created or hoisted above this point. Caught by test/extension.js.
  const handlers = createCommandHandlers({
    vscode,
    api,
    sync,
    permissions,
    folders,
    provider,
    panels,
    editors,
    drafts,
    getCwd,
    defaultAgent,
    refreshSessions,
    beginArchive,
    setArchivedState,
    archiveFinalizations,
    log,
  });

  sidebar = new SessionsSidebar({
    vscode,
    extensionUri: context.extensionUri,
    api,
    provider,
    getCwd,
    defaultAgent,
    setDefaultAgent: handlers.setDefaultAgent,
    getActiveSession() {
      const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
      return tab?.input?.viewType === 'opencode.sessionEditor'
        ? editors.sessionId(tab.input.uri) || null : null;
    },
    log,
    moveToFolder: handlers.moveSessionToFolder,
    actions: {
      openSession: handlers.openSession,
      newSession: handlers.newSession,
      renameSession: handlers.renameSession,
      deleteSession: handlers.deleteSession,
      archiveSession: handlers.archiveSession,
      restoreSession: handlers.restoreSession,
      moveSessionTo: handlers.moveSessionTo,
      deleteFolder: handlers.deleteFolder,
      showLog: () => output.show(true),
    },
  });

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const tabs = vscode.window.tabGroups;
  if (tabs?.onDidChangeTabs) {
    context.subscriptions.push(tabs.onDidChangeTabs(() => sidebar.syncActiveSession()));
  }
  if (tabs?.onDidChangeTabGroups) {
    context.subscriptions.push(tabs.onDidChangeTabGroups(() => sidebar.syncActiveSession()));
  }

  context.subscriptions.push(
    provider.onDidChangeTreeData(() => {
      sidebar.postSessions();
      // The list can receive a generated title before (or without) an ACP title event.
      const pending = [...provider.getChildren()];
      const seen = new Set();
      while (pending.length) {
        const item = pending.pop();
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        if (item.kind !== 'folder') {
          panels.get(item.id)?.applyTitle(item.title);
          panels.get(item.id)?.setArchived(provider.isArchived(item.id));
        }
        pending.push(...provider.getChildren(item));
      }
    })
  );

  // Refresh opening title snapshots once VS Code has restored background editors.
  const tabTitleTimer = setTimeout(() => {
    editors.refreshTabTitles().catch((error) =>
      log(`Cannot refresh session tab titles: ${error.message}`)
    );
  }, 1000);
  tabTitleTimer.unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(tabTitleTimer) });

  const withSidebarContext = (handler) => (item, ...args) =>
    handler(sidebar.resolveContext(item) || item, ...args);

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.newSession', handlers.newSession),
    vscode.commands.registerCommand('opencode.selectDefaultAgent', handlers.selectDefaultAgent),
    vscode.commands.registerCommand('opencode.selectDefaultModel', handlers.chooseDefaultModel),
    vscode.commands.registerCommand('opencode.refreshSessions', refreshSessions),
    vscode.commands.registerCommand('opencode.openSession', withSidebarContext(handlers.openSession)),
    vscode.commands.registerCommand('opencode.deleteSession', withSidebarContext(handlers.deleteSession)),
    vscode.commands.registerCommand('opencode.newFolder', handlers.newFolder),
    vscode.commands.registerCommand('opencode.deleteFolder', withSidebarContext(handlers.deleteFolder)),
    vscode.commands.registerCommand('opencode.renameSession', withSidebarContext(handlers.renameSession)),
    vscode.commands.registerCommand('opencode.archiveSession', withSidebarContext(handlers.archiveSession)),
    vscode.commands.registerCommand('opencode.restoreSession', withSidebarContext(handlers.restoreSession)),
    vscode.commands.registerCommand('opencode.moveSessionTo', withSidebarContext(handlers.moveSessionTo)),
    vscode.commands.registerCommand('opencode.showLog', () => output.show(true)),
    vscode.commands.registerCommand('opencode.openSettings', handlers.openSettings),
    vscode.commands.registerCommand('opencode.openGlobalConfig', handlers.openGlobalConfig),
    vscode.commands.registerCommand('opencode.openPermissionRules', handlers.openPermissionRules),
    vscode.commands.registerCommand('opencode.openProjectConfig', handlers.openProjectConfig)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateViewDescription();
      scheduleRefresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
        updateViewDescription();
        scheduleRefresh();
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        scheduleRefresh();
        editors.scheduleOrphanCheck();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('opencodeSessions.command') ||
        event.affectsConfiguration('opencode.command')
      ) {
        const command = getConfig().command;
        api.setCommand(command);
        permissions.command = command;
        permissions.installation = null;
        archive.command = command;
        archive.installation = null;
        sync.restart(command).catch((error) => {
          log(`Settings sync restart failed: ${error.stack || error.message}`);
        });
      }
      if (
        event.affectsConfiguration('opencodeSessions') ||
        event.affectsConfiguration('opencode')
      ) {
        scheduleRefresh();
      }
    })
  );

  updateViewDescription();
  if (sidebar.visible) refreshSessions();

  context.subscriptions.push({
    dispose() {
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const panel of [...allPanels]) panel.dispose();
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

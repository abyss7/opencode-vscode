'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { OpenCodeApi } = require('./api');
const { SessionsProvider, sessionTitle } = require('./sessions-view');
const { SessionFolders } = require('./session-folders');
const { SessionPanel } = require('./session-panel');
const { SessionEditors } = require('./session-editor');
const { SessionContinuation } = require('./session-continuation');
const { OpenCodeSync } = require('./opencode-sync');
const { refreshSettingEnums } = require('./setting-enums');
const { resolveCommand } = require('./util');
const { PermissionService } = require('./permission-service');
const { ArchiveService } = require('./archive-service');
const { SessionsSidebar } = require('./sessions-sidebar');
const { agentLabel } = require('./agent-label');

const VIEW_ID = 'opencode.sessions';

function isFolderNode(node) {
  return Boolean(node) && node.kind === 'folder';
}

function isSessionNode(node) {
  return Boolean(node) && node.kind !== 'folder' && typeof node.id === 'string';
}

function sessionFrom(item) {
  if (!item) return null;
  if (item.session && item.session.id) return item.session;
  return isSessionNode(item) ? item : null;
}

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
  const continuations = new SessionContinuation(context.globalStorageUri?.fsPath
    ? path.join(context.globalStorageUri.fsPath, 'continuations') : null);
  const permissions = new PermissionService({ vscode, api, command: getConfig().command, log });
  const archive = new ArchiveService({ api, command: getConfig().command, log });
  const sync = new OpenCodeSync({ vscode, command: getConfig().command, log });
  context.subscriptions.push(sync);
  sync.start().catch((error) => {
    log(`Settings sync failed to start: ${error.stack || error.message}`);
  });

  function getActiveFileUri() {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document.uri.scheme === 'file' ? editor.document.uri : null;
  }

  function getCwd() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const activeUri = getActiveFileUri();
      if (activeUri && folders.length > 1) {
        const folder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (folder) return folder.uri.fsPath;
      }
      return folders[0].uri.fsPath;
    }
    const activeUri = getActiveFileUri();
    return activeUri ? path.dirname(activeUri.fsPath) : null;
  }

  const folders = new SessionFolders(context.globalState);
  function defaultAgent(cwd) {
    const uri = cwd ? vscode.Uri.file(cwd) : undefined;
    return vscode.workspace.getConfiguration('opencodeSessions', uri).get('defaultAgent', '') ||
      vscode.workspace.getConfiguration('opencode', uri).get('default_agent', 'build') || 'build';
  }
  const provider = new SessionsProvider(api, getCwd, log, folders);
  const sidebar = new SessionsSidebar({ vscode, extensionUri: context.extensionUri,
    api, provider, getCwd, defaultAgent, setDefaultAgent, log, moveToFolder: moveSessionToFolder,
    actions: { openSession, newSession, renameSession, deleteSession, archiveSession,
      restoreSession, moveSessionTo, deleteFolder, showLog: () => output.show(true) } });
  context.subscriptions.push(provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, sidebar, { webviewOptions: { retainContextWhenHidden: true } }));

  const panels = new Map();
  const allPanels = new Set();
  context.subscriptions.push(provider.onDidChangeTreeData(() => {
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
  }));
  let refreshTimer = null;

  function updateViewDescription() {
    const cwd = getCwd();
    sidebar.description = cwd ? path.basename(cwd) : undefined;
  }

  async function refreshSessions() {
    updateViewDescription();
    await sidebar.refresh();
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

  const deps = {
    extensionUri: context.extensionUri,
    api,
    log,
    continuations,
    getConfig,
    permissions,
    archive,
    defaultAgent,
    openSession: (sessionId, cwd) => openSession(sessionId, cwd),
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
    onArchivedChanged: setArchivedState,
  };

  const editors = new SessionEditors({ vscode, context, api,
    createPanel({ panel, title, ...options }) {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      };
      const sessionPanel = new SessionPanel({ panel, deps, ...options });
      if (title) sessionPanel.applyTitle(title);
      allPanels.add(sessionPanel);
      panels.set(options.sessionId || options.newSessionId, sessionPanel);
    },
  });

  function openSession(sessionOrItem, cwdHint) {
    const session =
      sessionOrItem && sessionOrItem.session ? sessionOrItem.session : sessionOrItem;
    if (!session) return;

    const sessionId = typeof session === 'string' ? session : session.id;
    if (!sessionId) return;

    const existing = panels.get(sessionId);
    if (existing) {
      if (session.title) existing.applyTitle(session.title);
      existing.reveal();
      return;
    }

    const cwd =
      cwdHint ||
      (session.location && session.location.directory) ||
      getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }

    return editors.open(sessionId, cwd, session.title, { archived: provider.isArchived(sessionId) });
  }

  async function setArchivedState(sessionId, archived) {
    panels.get(sessionId)?.setArchived(archived);
    await editors.setArchived(sessionId, archived);
  }

  async function newSession() {
    const cwd = getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    return editors.open(null, cwd);
  }

  async function selectDefaultAgent() {
    const cwd = getCwd();
    if (!cwd) return;
    try {
      const agents = await api.listAgents(cwd);
      const selected = await vscode.window.showQuickPick(agents
        .filter((agent) => !agent.hidden && ['primary', 'all'].includes(agent.mode))
        .map((agent) => ({ label: agentLabel(agent.id, agent.name), agentID: agent.id, description: agent.description,
          picked: agent.id === defaultAgent(cwd) })),
      { title: 'Agent for new sessions', placeHolder: 'Existing sessions keep their agent' });
      if (!selected) return;
      await setDefaultAgent(selected.agentID);
      await refreshSessions();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to select agent: ${error.message}`);
    }
  }

  async function setDefaultAgent(id) {
    const cwd = getCwd();
    if (!cwd) throw new Error('Open a workspace folder first.');
    const agents = await api.listAgents(cwd);
    if (!agents.some((agent) => agent.id === id && !agent.hidden && ['primary', 'all'].includes(agent.mode))) {
      throw new Error('This agent is not available for new sessions.');
    }
    const uri = vscode.Uri.file(cwd);
    const target = vscode.workspace.getWorkspaceFolder(uri)
      ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('opencodeSessions', uri).update('defaultAgent', id, target);
  }

  async function deleteSession(sessionOrItem) {
    const session =
      sessionOrItem && sessionOrItem.session ? sessionOrItem.session : sessionOrItem;
    if (!session || !session.id) return;

    const title = sessionTitle(session);
    const answer = await vscode.window.showWarningMessage(
      `Delete session "${title}"?`,
      {
        modal: true,
        detail: 'The session and all its child sessions will be permanently deleted.',
      },
      'Delete'
    );
    if (answer !== 'Delete') return;

    const panel = panels.get(session.id);
    if (panel) panel.dispose();

    try {
      await api.deleteSession(session.id);
      log(`Deleted session: ${session.id}`);
      await refreshSessions();
    } catch (error) {
      log(`Failed to delete session ${session.id}: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Failed to delete session: ${error.message}`);
    }
  }

  async function newFolder() {
    const cwd = getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'New Folder',
      prompt: 'Folder name for sessions',
      placeHolder: 'e.g. Frontend',
      validateInput: (value) => folders.validate(cwd, value),
    });
    if (name === undefined) return;
    try {
      folders.add(cwd, name);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
      return;
    }
    await refreshSessions();
  }

  async function deleteFolder(item) {
    const cwd = getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    const group = item && item.folder ? item.folder : item;
    if (!isFolderNode(group) || group.system !== 'custom') return;

    const answer = await vscode.window.showWarningMessage(
      `Delete folder "${group.name}"?`,
      {
        modal: true,
        detail:
          'Sessions in this folder move to Ungrouped. The sessions themselves are not deleted.',
      },
      'Delete'
    );
    if (answer !== 'Delete') return;

    folders.remove(cwd, group.id);
    log(`Deleted session folder: ${group.name}`);
    await refreshSessions();
  }

  async function renameSession(item) {
    const session = sessionFrom(item);
    if (!session) return;
    const current = sessionTitle(session);

    const title = await vscode.window.showInputBox({
      title: 'Rename Session',
      prompt: 'Session title',
      value: current,
      validateInput: (value) =>
        String(value || '').trim() ? null : 'Title cannot be empty.',
    });
    if (title === undefined) return;
    const value = String(title).trim();
    if (!value || value === current) return;

    try {
      await api.updateSession(session.id, { title: value });
    } catch (error) {
      log(`Failed to rename session ${session.id}: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Failed to rename session: ${error.message}`);
      return;
    }

    log(`Renamed session ${session.id} to "${value}"`);
    const panel = panels.get(session.id);
    if (panel) panel.applyTitle(value);
    await refreshSessions();
  }

  async function archiveSession(item) {
    const session = sessionFrom(item);
    if (!session) return;
    try {
      const cwd = session.location?.directory || getCwd();
      await archive.archive(session.id, cwd);
      await setArchivedState(session.id, true);
    } catch (error) {
      log(`Failed to archive session ${session.id}: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Failed to archive session: ${error.message}`);
      return;
    }
    log(`Archived session: ${session.id}`);
    await refreshSessions();
  }

  async function restoreSession(item) {
    const session = sessionFrom(item);
    if (!session) return;
    try {
      await api.updateSession(session.id, { archived: false });
      await setArchivedState(session.id, false);
    } catch (error) {
      log(`Failed to restore session ${session.id}: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Failed to restore session: ${error.message}`);
      return;
    }
    log(`Restored session: ${session.id}`);
    await refreshSessions();
  }

  async function moveSessionToFolder(session, folderId) {
    try {
      const moved = await provider.moveSession(session.id, folderId);
      if (!moved) return;
    } catch (error) {
      log(`Failed to move session ${session.id}: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Failed to move session: ${error.message}`);
      return;
    }
    log(`Moved session ${session.id} to ${folderId}`);
    await refreshSessions();
  }

  async function moveSessionTo(item) {
    const session = sessionFrom(item);
    if (!session) return;
    const current = provider.folderIdOf(session.id);
    const choices = provider
      .folderChoices()
      .filter((choice) => choice.folderId !== current);
    if (choices.length === 0) return;

    const picked = await vscode.window.showQuickPick(choices, {
      title: 'Move to',
      placeHolder: `Move "${sessionTitle(session)}" to folder`,
    });
    if (!picked) return;
    await moveSessionToFolder(session, picked.folderId);
  }

  async function openSettings() {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:abyss7.opencode-sessions'
    );
  }

  function ensureConfigFile(file) {
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
      'utf8'
    );
  }

  async function openConfigFile(file) {
    if (!file) {
      vscode.window.showWarningMessage('OpenCode configuration file was not found.');
      return;
    }
    ensureConfigFile(file);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
  }

  async function openGlobalConfig() {
    await sync.start();
    await openConfigFile(sync.globalConfigFile());
  }

  async function openProjectConfig() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    let folder = folders[0];
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(
        folders.map((entry) => ({ label: entry.name, folder: entry })),
        { placeHolder: 'Select a workspace folder' }
      );
      if (!picked) return;
      folder = picked.folder;
    }
    await openConfigFile(sync.projectConfigFile(folder.uri) || path.join(folder.uri.fsPath, 'opencode.jsonc'));
  }

  const withSidebarContext = (handler) => (item, ...args) => handler(sidebar.resolveContext(item) || item, ...args);
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.newSession', newSession),
    vscode.commands.registerCommand('opencode.selectDefaultAgent', selectDefaultAgent),
    vscode.commands.registerCommand('opencode.refreshSessions', refreshSessions),
    vscode.commands.registerCommand('opencode.openSession', withSidebarContext(openSession)),
    vscode.commands.registerCommand('opencode.deleteSession', withSidebarContext(deleteSession)),
    vscode.commands.registerCommand('opencode.newFolder', newFolder),
    vscode.commands.registerCommand('opencode.deleteFolder', withSidebarContext(deleteFolder)),
    vscode.commands.registerCommand('opencode.renameSession', withSidebarContext(renameSession)),
    vscode.commands.registerCommand('opencode.archiveSession', withSidebarContext(archiveSession)),
    vscode.commands.registerCommand('opencode.restoreSession', withSidebarContext(restoreSession)),
    vscode.commands.registerCommand('opencode.moveSessionTo', withSidebarContext(moveSessionTo)),
    vscode.commands.registerCommand('opencode.showLog', () => output.show(true)),
    vscode.commands.registerCommand('opencode.openSettings', openSettings),
    vscode.commands.registerCommand('opencode.openGlobalConfig', openGlobalConfig),
    vscode.commands.registerCommand('opencode.openPermissionRules', async () => {
      const cwd = getCwd();
      if (!cwd) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      try { await permissions.openRules(cwd); }
      catch (error) { vscode.window.showErrorMessage(`Cannot open permission rules: ${error.message}`); }
    }),
    vscode.commands.registerCommand('opencode.openProjectConfig', openProjectConfig)
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
      if (state.focused) scheduleRefresh();
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

  // The Settings dropdowns come from `contributes.configuration`, which is read
  // once per extension host, so the model and agent lists are refreshed here and
  // picked up on the next reload.
  const extensionRoot = context.extensionUri && context.extensionUri.fsPath;
  if (extensionRoot) {
    refreshSettingEnums({
      vscode,
      api,
      cwd: getCwd() || undefined,
      file: path.join(extensionRoot, 'package.json'),
      log,
    }).catch((error) => {
      log(`Setting enum refresh failed: ${error.stack || error.message}`);
    });
  }

  context.subscriptions.push({
    dispose() {
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const panel of [...allPanels]) panel.dispose();
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

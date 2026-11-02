'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { OpenCodeApi } = require('./api');
const { SessionsProvider, sessionTitle } = require('./sessions-view');
const { SessionFolders } = require('./session-folders');
const { SessionPanel } = require('./session-panel');
const { OpenCodeSync } = require('./opencode-sync');
const { refreshSettingEnums } = require('./setting-enums');
const { resolveCommand } = require('./util');

const VIEW_ID = 'opencode.sessions';
const PANEL_VIEW_TYPE = 'opencode.session';
const DRAG_MIME_TYPE = 'application/vnd.code.tree.opencode.sessions';

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
  const provider = new SessionsProvider(api, getCwd, log, folders);
  const dragAndDropController = {
    dragMimeTypes: [DRAG_MIME_TYPE],
    dropMimeTypes: [DRAG_MIME_TYPE],
    handleDrag(source, dataTransfer) {
      const sessions = (source || []).filter(isSessionNode);
      if (sessions.length > 0) dataTransfer.set(DRAG_MIME_TYPE, sessions);
    },
    async handleDrop(target, dataTransfer) {
      if (!isFolderNode(target)) return;
      const items = dataTransfer.get(DRAG_MIME_TYPE) || [];
      for (const item of items) {
        const session = sessionFrom(item);
        if (session) await moveSessionToFolder(session, target.id);
      }
    },
  };
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    dragAndDropController,
  });
  context.subscriptions.push(treeView, provider);

  const panels = new Map();
  const allPanels = new Set();
  let refreshTimer = null;

  function updateViewDescription() {
    const cwd = getCwd();
    treeView.description = cwd ? path.basename(cwd) : undefined;
  }

  async function refreshSessions() {
    updateViewDescription();
    await provider.refresh();
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshSessions();
    }, 300);
  }

  const deps = {
    extensionUri: context.extensionUri,
    api,
    log,
    getConfig,
    openSession: (sessionId, cwd) => openSession(sessionId, cwd),
    onSessionCreated(panel, sessionId, cwd) {
      log(`Session created: ${sessionId} (${cwd})`);
      if (!panel.disposed) {
        panels.set(sessionId, panel);
      }
      scheduleRefresh();
    },
    onSessionDisposed(panel) {
      allPanels.delete(panel);
      if (panel.sessionId && panels.get(panel.sessionId) === panel) {
        panels.delete(panel.sessionId);
      }
    },
    onSessionChanged() {
      scheduleRefresh();
    },
  };

  function openPanel(sessionId, cwd) {
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      sessionId ? 'OpenCode' : 'New Session',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    const sessionPanel = new SessionPanel({
      panel,
      sessionId,
      cwd,
      deps,
    });
    allPanels.add(sessionPanel);
    if (sessionId) panels.set(sessionId, sessionPanel);
    return sessionPanel;
  }

  function openSession(sessionOrItem, cwdHint) {
    const session =
      sessionOrItem && sessionOrItem.session ? sessionOrItem.session : sessionOrItem;
    if (!session) return;

    const sessionId = typeof session === 'string' ? session : session.id;
    if (!sessionId) return;

    const existing = panels.get(sessionId);
    if (existing) {
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

    openPanel(sessionId, cwd);
  }

  async function newSession() {
    const cwd = getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    openPanel(null, cwd);
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
      await api.updateSession(session.id, { archived: true });
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

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.newSession', newSession),
    vscode.commands.registerCommand('opencode.refreshSessions', refreshSessions),
    vscode.commands.registerCommand('opencode.openSession', openSession),
    vscode.commands.registerCommand('opencode.deleteSession', deleteSession),
    vscode.commands.registerCommand('opencode.newFolder', newFolder),
    vscode.commands.registerCommand('opencode.deleteFolder', deleteFolder),
    vscode.commands.registerCommand('opencode.renameSession', renameSession),
    vscode.commands.registerCommand('opencode.archiveSession', archiveSession),
    vscode.commands.registerCommand('opencode.restoreSession', restoreSession),
    vscode.commands.registerCommand('opencode.moveSessionTo', moveSessionTo),
    vscode.commands.registerCommand('opencode.showLog', () => output.show(true)),
    vscode.commands.registerCommand('opencode.openSettings', openSettings),
    vscode.commands.registerCommand('opencode.openGlobalConfig', openGlobalConfig),
    vscode.commands.registerCommand('opencode.openProjectConfig', openProjectConfig)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const sessionId = state && state.sessionId;
        const cwd = (state && state.cwd) || getCwd();
        if (!sessionId || !cwd) {
          panel.dispose();
          return;
        }
        panel.webview.options = {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        };
        const sessionPanel = new SessionPanel({
          panel,
          sessionId,
          cwd,
          deps,
        });
        allPanels.add(sessionPanel);
        panels.set(sessionId, sessionPanel);
      },
    })
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
    }),
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) scheduleRefresh();
    })
  );

  updateViewDescription();
  if (treeView.visible) refreshSessions();

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

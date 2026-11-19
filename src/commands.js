'use strict';

/**
 * @file User-facing VS Code command handlers for managing sessions, folders,
 * default agent/model selections, archiving, and configuration files.
 *
 * Separated from `src/extension.js` so activation/wiring stays compact while
 * interactive dialogs and session-tree mutations live in one place.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sessionTitle } = require('./sessions-view');
const { selectDefaultModel } = require('./model-defaults');
const { agentLabel } = require('./agent-label');

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

function ensureConfigFile(file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    'utf8'
  );
}

function createCommandHandlers({
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
}) {
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

  async function newSession() {
    const cwd = getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    return editors.open(null, cwd);
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
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('opencodeSessions', uri).update('defaultAgent', id, target);
  }

  async function selectDefaultAgent() {
    const cwd = getCwd();
    if (!cwd) return;
    try {
      const agents = await api.listAgents(cwd);
      const selected = await vscode.window.showQuickPick(
        agents
          .filter((agent) => !agent.hidden && ['primary', 'all'].includes(agent.mode))
          .map((agent) => ({
            label: agentLabel(agent.id, agent.name),
            agentID: agent.id,
            description: agent.description,
            picked: agent.id === defaultAgent(cwd),
          })),
        { title: 'Agent for new sessions', placeHolder: 'Existing sessions keep their agent' }
      );
      if (!selected) return;
      await setDefaultAgent(selected.agentID);
      await refreshSessions();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to select agent: ${error.message}`);
    }
  }

  async function chooseDefaultModel() {
    try {
      await selectDefaultModel({ vscode, api, cwd: getCwd() || undefined, log });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to select model: ${error.message}`);
    }
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
      drafts?.save(session.id, '');
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
      await beginArchive(session.id, cwd);
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
      archiveFinalizations.delete(session.id);
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
    const target = String(folderId || '');
    const wasArchived = provider.isArchived(session.id);
    const willArchive = target === 'archived';
    try {
      if (!wasArchived && willArchive) {
        if (!provider.hasFolder(target)) return;
        const cwd = session.location?.directory || getCwd();
        if (!cwd) return;
        await beginArchive(session.id, cwd);
      } else {
        if (wasArchived) archiveFinalizations.delete(session.id);
        const moved = await provider.moveSession(session.id, target);
        if (!moved) return;
        if (wasArchived) await setArchivedState(session.id, false);
      }
    } catch (error) {
      log(`Failed to move session ${session.id}: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Failed to move session: ${error.message}`);
      return;
    }
    log(`Moved session ${session.id} to ${target}`);
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
    const foldersList = vscode.workspace.workspaceFolders;
    if (!foldersList || foldersList.length === 0) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    let folder = foldersList[0];
    if (foldersList.length > 1) {
      const picked = await vscode.window.showQuickPick(
        foldersList.map((entry) => ({ label: entry.name, folder: entry })),
        { placeHolder: 'Select a workspace folder' }
      );
      if (!picked) return;
      folder = picked.folder;
    }
    await openConfigFile(sync.projectConfigFile(folder.uri) || path.join(folder.uri.fsPath, 'opencode.jsonc'));
  }

  async function openPermissionRules() {
    const cwd = getCwd();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    try {
      await permissions.openRules(cwd);
    } catch (error) {
      vscode.window.showErrorMessage(`Cannot open permission rules: ${error.message}`);
    }
  }

  return {
    openSession,
    newSession,
    setDefaultAgent,
    selectDefaultAgent,
    chooseDefaultModel,
    deleteSession,
    newFolder,
    deleteFolder,
    renameSession,
    archiveSession,
    restoreSession,
    moveSessionToFolder,
    moveSessionTo,
    openSettings,
    openGlobalConfig,
    openProjectConfig,
    openPermissionRules,
  };
}

module.exports = { createCommandHandlers, isFolderNode, isSessionNode, sessionFrom };

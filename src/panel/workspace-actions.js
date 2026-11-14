'use strict';

/**
 * @file Workspace file/diff/link actions and command/skill discovery for
 * `SessionPanel`.
 */

const fs = require('node:fs');
const vscode = require('vscode');
const { DiffDocuments } = require('../diff-documents');
const { exportArtifact } = require('../artifact-export');
const { resolveFileTarget } = require('../file-links');

const panelWorkspaceActions = {
  async _loadSlashItems() {
    if (this._disposed) return;
    const [skills, serverCommands] = await Promise.all([
      this.deps.api.listSkills(this.cwd).catch((error) => {
        this.deps.log(`Failed to load skills: ${error.message}`);
        return [];
      }),
      this.deps.api.listCommands(this.cwd).catch((error) => {
        this.deps.log(`Failed to load commands: ${error.message}`);
        return [];
      }),
    ]);
    if (this._disposed) return;
    const commands = serverCommands.some((item) => item && item.name === 'compact')
      ? serverCommands
      : [...serverCommands, { name: 'compact', description: 'Compact the session' }];
    this._post({ type: 'slashItems', skills, commands });
  },

  /**
   * Open another session (for example a sub-agent) in its own tab.
   */
  async _openSession(sessionId) {
    if (this._disposed || !sessionId) return;
    if (typeof this.deps.openSession === 'function') {
      try {
        await this.deps.openSession(sessionId, this.cwd);
      } catch (error) {
        this.deps.log(`Cannot open session ${sessionId}: ${error.message}`);
        this._post({ type: 'error', message: `Cannot open session: ${error.message}` });
      }
    }
  },

  _openExternal(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
  },

  _baseDir() {
    if (this.cwd) return this.cwd;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0 && folders[0].uri) {
      return folders[0].uri.fsPath;
    }
    return process.cwd();
  },

  _checkFiles(files) {
    const base = this._baseDir();
    const results = [];
    for (const item of files) {
      const key = item && typeof item.key === 'string' ? item.key : null;
      if (!key) continue;
      const target = resolveFileTarget(base, item.path);
      let exists = false;
      if (target) {
        try {
          exists = fs.statSync(target.filePath).isFile();
        } catch {
          exists = false;
        }
      }
      results.push({ key, exists });
    }
    this._post({ type: 'fileChecks', files: results });
  },

  async _openFile(reference, line, column) {
    const target = resolveFileTarget(this._baseDir(), reference);
    if (!target) return;

    const lineNumber = line || target.line;
    const columnNumber = column || target.column;
    const options = {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
      preserveFocus: false,
    };

    if (lineNumber) {
      const position = new vscode.Position(
        Math.max(0, lineNumber - 1),
        Math.max(0, (columnNumber || 1) - 1)
      );
      options.selection = new vscode.Range(position, position);
    }

    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(target.filePath)
      );
      if (this._disposed) return;
      await vscode.window.showTextDocument(document, options);
    } catch (error) {
      // A chat reference may point at a file that does not exist; ignore it.
      this.deps.log(`Failed to open ${target.filePath}: ${error.message}`);
    }
  },

  _openDiff(message) {
    if (!this._diffDocuments) {
      this._diffDocuments = new DiffDocuments();
      this._disposables.push(this._diffDocuments);
    }
    this._diffDocuments.open(message).catch((error) => {
      this.deps.log(`Failed to open diff: ${error.message}`);
      this._post({ type: 'error', message: `Failed to open diff: ${error.message}` });
    });
  },

  _exportArtifact(message) {
    exportArtifact(message).catch((error) =>
      this._post({ type: 'error', message: `Export failed: ${error.message}` })
    );
  },
};

module.exports = { panelWorkspaceActions };

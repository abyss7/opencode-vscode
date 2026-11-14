'use strict';

/**
 * @file VS Code setting storage backends for `OpenCodeSync`:
 * - `ApiVsSide`: reads/writes via `vscode.workspace.getConfiguration`
 * - `FileVsSide`: reads/writes JSONC machine settings directly in remote windows
 */

const { getPath } = require('../jsonc');
const { PREFIX, readSettingFromObject } = require('./rules');

class ApiVsSide {
  constructor(vscode, scopeUri, target, log) {
    this.vscode = vscode;
    this.scopeUri = scopeUri;
    this.target = target;
    this.log = log;
  }

  _configuration() {
    // Setting IDs already include "opencode.". Selecting that section here
    // would make inspect/update address "opencode.opencode.<setting>".
    return this.vscode.workspace.getConfiguration(undefined, this.scopeUri);
  }

  _valueName() {
    if (this.target === 'global') return 'globalValue';
    if (this.target === 'workspace') return 'workspaceValue';
    return 'workspaceFolderValue';
  }

  async readAll(settings) {
    const configuration = this._configuration();
    const key = this._valueName();
    const values = new Map();
    for (const meta of settings) {
      let inspected;
      try {
        inspected = configuration.inspect(meta.id);
      } catch {
        inspected = undefined;
      }
      values.set(meta.id, inspected ? inspected[key] : undefined);
    }
    return values;
  }

  async writeAll(operations) {
    const configuration = this._configuration();
    const target =
      this.target === 'global'
        ? this.vscode.ConfigurationTarget.Global
        : this.target === 'workspace'
          ? this.vscode.ConfigurationTarget.Workspace
          : this.vscode.ConfigurationTarget.WorkspaceFolder;

    for (const operation of operations) {
      try {
        await configuration.update(operation.id, operation.value, target);
      } catch (error) {
        this.log(
          `Failed to update VS Code setting ${operation.id}: ${error.message || error}`
        );
      }
    }
  }
}

class FileVsSide {
  constructor(store, file, log) {
    this.store = store;
    this.file = file;
    this.log = log;
  }

  async readAll(settings) {
    const { value } = await this.store.read(this.file);
    const values = new Map();
    for (const meta of settings) {
      values.set(meta.id, readSettingFromObject(value, meta));
    }
    return values;
  }

  async writeAll(operations) {
    if (operations.length === 0) return;
    const { value: current } = await this.store.read(this.file);
    const fileOperations = [];
    for (const operation of operations) {
      // VS Code stores machine settings as flat dotted keys
      // (`"opencode.model": ...`), never as a nested `opencode` object.
      if (operation.value === undefined) {
        fileOperations.push({ path: [operation.id], unset: true });
      } else {
        fileOperations.push({ path: [operation.id], value: operation.value });
      }
      // Drop a legacy nested form left by earlier versions, but only when it
      // actually exists: unsetting an absent path makes jsonc.modify throw
      // "Can not delete in empty document".
      if (getPath(current, [PREFIX, ...operation.path]) !== undefined) {
        fileOperations.push({ path: [PREFIX, ...operation.path], unset: true });
      }
    }
    try {
      await this.store.write(this.file, fileOperations, { initial: '{}\n' });
    } catch (error) {
      this.log(
        `Failed to update VS Code machine settings ${this.file}: ${error.message || error}`
      );
    }
  }
}

module.exports = { ApiVsSide, FileVsSide };

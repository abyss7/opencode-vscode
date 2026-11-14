'use strict';

/**
 * @file Two-way settings synchronizer (`OpenCodeSync`) between OpenCode's
 * global/project `opencode.json(c)` files and VS Code configuration scopes.
 *
 * Pure merge rules live in `./sync/rules.js`; VS Code configuration adapters
 * live in `./sync/vs-sides.js`.
 */

const path = require('node:path');
const { JsoncStore, getPath, deepEqual } = require('./jsonc');
const configPaths = require('./opencode-config');
const generated = require('./generated/opencode-settings.json');
const {
  PREFIX,
  typeMatches,
  isCompatible,
  decideSync,
  normalizeValue,
  readSettingFromObject,
  samePath,
} = require('./sync/rules');
const { ApiVsSide, FileVsSide } = require('./sync/vs-sides');

const SETTINGS = generated.settings;
const SYNC_DELAY_MS = 300;

class OpenCodeSync {
  constructor(options = {}) {
    this.vscode = options.vscode;
    this.command = options.command || 'opencode';
    this.log = options.log || (() => {});
    this.store = new JsoncStore({ vscode: this.vscode, log: this.log });

    this._disposed = false;
    this._scopes = [];
    this._snapshots = new Map();
    this._ignored = new Map();
    this._dirtyLogged = new Set();
    this._watchers = [];
    this._disposables = [];
    this._timer = null;
    this._chain = Promise.resolve();
    this._globalDir = null;
    this._started = false;
    this._startPromise = null;
  }

  async start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._start().catch((error) => {
      this._startPromise = null;
      this._started = false;
      throw error;
    });
    return this._startPromise;
  }

  async _start() {
    if (this._started) return;
    this._started = true;
    if (process.env.OPENCODE_DISABLE_SETTINGS_SYNC === '1') {
      this.log('Settings sync disabled by OPENCODE_DISABLE_SETTINGS_SYNC');
      return;
    }
    if (!this.vscode) return;

    this._globalDir = await configPaths.resolveGlobalConfigDir({
      command: this.command,
    });
    await this._rebuild();
    this._registerEvents();
    this.log(`Settings sync: global config directory ${this._globalDir}`);
  }

  async restart(command) {
    if (!command || command === this.command) return;
    this.command = command;
    this._globalDir = await configPaths.resolveGlobalConfigDir({ command });
    await this._rebuild();
    this.log(`Settings sync: restarted with ${command}`);
  }

  globalConfigFile() {
    if (!this._globalDir) return null;
    return (
      configPaths.findConfigFile(this._globalDir) ||
      path.join(this._globalDir, 'opencode.jsonc')
    );
  }

  projectConfigFile(folderUri) {
    const folders = this.vscode.workspace.workspaceFolders || [];
    const folder = folderUri
      ? folders.find((entry) => entry.uri.toString() === folderUri.toString())
      : folders[0];
    if (!folder) return null;
    return configPaths.projectConfigFile(folder.uri.fsPath);
  }

  dispose() {
    this._disposed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._disposeWatchers();
    for (const disposable of this._disposables) {
      try { disposable.dispose(); } catch { /* Ignore */ }
    }
    this._disposables = [];
  }

  schedule(delay = SYNC_DELAY_MS) {
    if (this._disposed) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._enqueue();
    }, delay);
    if (this._timer.unref) this._timer.unref();
  }

  _enqueue() {
    if (this._disposed) return this._chain;
    const run = async () => {
      for (const scope of this._scopes) {
        if (this._disposed) return;
        this._refreshScopeFile(scope);
        await this._reconcileScope(scope);
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  _refreshScopeFile(scope) {
    const directory =
      scope.kind === 'global'
        ? this._globalDir
        : (scope.kind === 'workspace' || scope.kind === 'folder') && scope.folder
          ? scope.folder.uri.fsPath
          : path.dirname(scope.file);
    if (!directory) return;
    const current =
      scope.kind === 'global'
        ? configPaths.findConfigFile(directory) || path.join(directory, 'opencode.jsonc')
        : configPaths.projectConfigFile(directory);
    if (!samePath(current, scope.file) && configPaths.fileExists(current)) {
      this.log(`Settings sync: ${scope.id} now uses ${current}`);
      scope.file = current;
    }
  }

  _machineSettingsTarget() {
    const existing = configPaths.machineSettingsFile();
    if (existing) return existing;
    for (const candidate of configPaths.machineSettingsCandidates()) {
      if (configPaths.directoryExists(path.dirname(candidate))) return candidate;
    }
    return null;
  }

  async _rebuild() {
    this._disposeWatchers();
    this._snapshots.clear();
    this._ignored.clear();
    this._dirtyLogged.clear();

    const globalDir = this._globalDir || configPaths.platformConfigDir();
    const globalFile =
      configPaths.findConfigFile(globalDir) || path.join(globalDir, 'opencode.jsonc');
    const existing = configPaths.findConfigFiles(globalDir);
    if (existing.length > 1) {
      this.log(
        `Settings sync: both ${existing.join(' and ')} exist; using the higher-priority ${globalFile}`
      );
    }

    const scopes = [];
    const remote = configPaths.isRemoteWindow(this.vscode);
    let globalSide;
    let globalSideFile = null;
    if (remote) {
      globalSideFile = this._machineSettingsTarget();
      if (globalSideFile) {
        globalSide = new FileVsSide(this.store, globalSideFile, this.log);
      } else {
        this.log(
          'Settings sync: remote machine settings file was not found; falling back to User settings'
        );
        globalSide = new ApiVsSide(this.vscode, undefined, 'global', this.log);
      }
    } else {
      globalSide = new ApiVsSide(this.vscode, undefined, 'global', this.log);
    }

    scopes.push({
      id: 'global',
      kind: 'global',
      file: globalFile,
      side: globalSide,
      sideFile: globalSideFile,
    });

    const folders = this.vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) {
      scopes.push({
        id: 'workspace',
        kind: 'workspace',
        folder: folders[0],
        file: configPaths.projectConfigFile(folders[0].uri.fsPath),
        side: new ApiVsSide(this.vscode, undefined, 'workspace', this.log),
      });
    } else if (folders.length > 1) {
      for (const folder of folders) {
        scopes.push({
          id: `folder:${folder.uri.fsPath}`,
          kind: 'folder',
          folder,
          file: configPaths.projectConfigFile(folder.uri.fsPath),
          side: new ApiVsSide(this.vscode, folder.uri, 'folder', this.log),
        });
      }
      this.log(
        'Settings sync: multi-root workspace; per-folder settings map to each folder, Workspace-level settings are not mapped'
      );
    }

    this._scopes = scopes;
    this._registerWatchers();
    await this._enqueue();
    for (const scope of scopes) {
      this.log(`Settings sync: ${scope.id} -> ${scope.file}`);
      if (scope.sideFile) {
        this.log(`Settings sync: ${scope.id} VS Code side -> ${scope.sideFile}`);
      }
    }
  }

  _registerEvents() {
    const vscode = this.vscode;
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(PREFIX)) this.schedule();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._rebuild().catch((error) => {
          this.log(`Settings sync: failed to rebuild after folder change: ${error.message}`);
        });
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri && document.uri.scheme === 'file' && this._isWatched(document.uri.fsPath)) {
          this.schedule();
        }
      })
    );
  }

  _isWatched(file) {
    for (const scope of this._scopes) {
      if (samePath(scope.file, file)) return true;
      if (scope.sideFile && samePath(scope.sideFile, file)) return true;
    }
    return false;
  }

  _registerWatchers() {
    const vscode = this.vscode;
    if (!vscode.workspace.createFileSystemWatcher) return;

    const addWatcher = (base, pattern) => {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(base, pattern)
        );
        watcher.onDidChange(() => this.schedule());
        watcher.onDidCreate(() => this.schedule());
        watcher.onDidDelete(() => this.schedule());
        this._watchers.push(watcher);
      } catch (error) {
        this.log(`Settings sync: failed to watch ${base}/${pattern}: ${error.message}`);
      }
    };

    const directories = new Set();
    for (const scope of this._scopes) {
      directories.add(path.dirname(scope.file));
      if (scope.sideFile) {
        addWatcher(path.dirname(scope.sideFile), path.basename(scope.sideFile));
      }
    }
    for (const directory of directories) {
      addWatcher(directory, 'opencode.json*');
      addWatcher(directory, '.opencode/opencode.json*');
    }
  }

  _disposeWatchers() {
    for (const watcher of this._watchers) {
      try { watcher.dispose(); } catch { /* Ignore */ }
    }
    this._watchers = [];
  }

  async _reconcileScope(scope) {
    const dirty =
      this.store.isDirty(scope.file) ||
      (scope.sideFile ? this.store.isDirty(scope.sideFile) : false);
    if (dirty) {
      if (!this._dirtyLogged.has(scope.id)) {
        this._dirtyLogged.add(scope.id);
        this.log(
          `Settings sync: ${scope.id} has unsaved editor changes; waiting for a save`
        );
      }
      return;
    }
    this._dirtyLogged.delete(scope.id);

    let openValue;
    let vsValues;
    try {
      const document = await this.store.read(scope.file);
      openValue = document.value || {};
      vsValues = await scope.side.readAll(SETTINGS);
    } catch (error) {
      this.log(`Settings sync: failed to read ${scope.id}: ${error.message || error}`);
      return;
    }

    const previous = this._snapshots.get(scope.id) || new Map();
    const next = new Map();
    const openOperations = [];
    const vsOperations = [];

    for (const meta of SETTINGS) {
      if (meta.scope === 'machine' && scope.kind !== 'global') continue;
      const open = normalizeValue(meta, getPath(openValue, meta.path));
      const vs = normalizeValue(meta, vsValues.get(meta.id));
      const ignoredKey = `${scope.id}:${meta.id}`;
      const ignored = this._ignored.get(ignoredKey);

      if (ignored && deepEqual(ignored.open, open)) {
        if (vs !== undefined) {
          vsOperations.push({ id: meta.id, path: meta.path, value: undefined });
        }
        next.set(meta.id, { open, vs: undefined });
        continue;
      }
      if (ignored) this._ignored.delete(ignoredKey);

      if (open !== undefined && !isCompatible(meta, open)) {
        this.log(
          `Settings sync: ${meta.id} in ${scope.file} has a shape VS Code cannot mirror; ` +
            'edit opencode.json(c) directly to change it'
        );
        this._ignored.set(ignoredKey, { open });
        if (vs !== undefined) {
          vsOperations.push({ id: meta.id, path: meta.path, value: undefined });
        }
        next.set(meta.id, { open, vs: undefined });
        continue;
      }

      if (vs !== undefined && !isCompatible(meta, vs)) {
        this.log(
          `Settings sync: VS Code value for ${meta.id} is not valid for OpenCode; ignoring it`
        );
        const mirror = open !== undefined && isCompatible(meta, open) ? open : undefined;
        if (!deepEqual(vs, mirror)) {
          vsOperations.push({ id: meta.id, path: meta.path, value: mirror });
        }
        next.set(meta.id, { open, vs: mirror });
        continue;
      }

      const decision = decideSync({ open, vs, previous: previous.get(meta.id) });
      if (!deepEqual(decision.nextOpen, open)) {
        openOperations.push(
          decision.nextOpen === undefined
            ? { path: meta.path, unset: true }
            : { path: meta.path, value: decision.nextOpen }
        );
      }
      if (!deepEqual(decision.nextVs, vs)) {
        vsOperations.push({
          id: meta.id,
          path: meta.path,
          value: decision.nextVs,
        });
      }
      next.set(meta.id, { open: decision.nextOpen, vs: decision.nextVs });
    }

    let wrote = false;

    if (openOperations.length > 0) {
      wrote = true;
      try {
        await this.store.write(scope.file, openOperations);
        this.log(
          `Settings sync: wrote ${openOperations.length} value(s) to ${scope.file}`
        );
      } catch (error) {
        this.log(`Settings sync: failed to write ${scope.file}: ${error.message || error}`);
      }
    }

    if (vsOperations.length > 0) {
      wrote = true;
      await scope.side.writeAll(vsOperations);
      this.log(
        `Settings sync: updated ${vsOperations.length} VS Code setting(s) for ${scope.id}`
      );
    }

    if (wrote) {
      // Re-read so a failed or partially applied write cannot desynchronize
      // the snapshots and start a write loop.
      try {
        const actualDocument = await this.store.read(scope.file);
        const actualVs = await scope.side.readAll(SETTINGS);
        for (const meta of SETTINGS) {
          const ignoredKey = `${scope.id}:${meta.id}`;
          if (this._ignored.has(ignoredKey)) continue;
          next.set(meta.id, {
            open: normalizeValue(meta, getPath(actualDocument.value || {}, meta.path)),
            vs: normalizeValue(meta, actualVs.get(meta.id)),
          });
        }
      } catch (error) {
        this.log(
          `Settings sync: failed to verify ${scope.id}: ${error.message || error}`
        );
      }
    }

    this._snapshots.set(scope.id, next);
  }
}

module.exports = {
  OpenCodeSync,
  decideSync,
  isCompatible,
  readSettingFromObject,
  normalizeValue,
  typeMatches,
  SETTINGS,
};

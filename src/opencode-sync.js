'use strict';

const path = require('node:path');
const { JsoncStore, getPath, deepEqual } = require('./jsonc');
const configPaths = require('./opencode-config');
const { modelRefString } = require('./setting-enums');
const generated = require('./generated/opencode-settings.json');

const SETTINGS = generated.settings;
const PREFIX = 'opencode';
const SYNC_DELAY_MS = 300;

function typeMatches(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function isCompatible(meta, value) {
  if (value === undefined) return true;

  const types = Array.isArray(meta.types) ? meta.types : [];
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    return false;
  }

  if (meta.kind === 'array') {
    if (!Array.isArray(value)) return false;
    if (meta.itemType && !value.every((item) => typeMatches(meta.itemType, item))) {
      return false;
    }
  }

  if (meta.kind === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  if (Array.isArray(meta.enum) && meta.enum.length > 0) {
    return meta.enum.some((entry) => deepEqual(entry, value));
  }

  if (typeof value === 'string' && typeof meta.pattern === 'string') {
    try {
      if (!new RegExp(meta.pattern).test(value)) return false;
    } catch {
      // Ignore an invalid pattern from a future schema.
    }
  }

  if (typeof value === 'number') {
    if (typeof meta.minimum === 'number' && value < meta.minimum) return false;
    if (typeof meta.maximum === 'number' && value > meta.maximum) return false;
    if (
      typeof meta.exclusiveMinimum === 'number' &&
      value <= meta.exclusiveMinimum
    ) {
      return false;
    }
  }

  if (Array.isArray(value)) {
    if (typeof meta.minItems === 'number' && value.length < meta.minItems) return false;
    if (typeof meta.maxItems === 'number' && value.length > meta.maxItems) return false;
  }

  return true;
}

/**
 * Three-way decision for one setting.
 *
 * `opencodeWins` is true: the OpenCode file is the source of truth when both
 * sides changed since the previous reconciliation.
 */
function decideSync({ open, vs, previous, opencodeWins = true }) {
  let nextOpen = open;
  let nextVs = vs;

  if (!previous) {
    if (open !== undefined && vs === undefined) {
      nextVs = open;
    } else if (open === undefined && vs !== undefined) {
      nextOpen = vs;
    } else if (open !== undefined && vs !== undefined && !deepEqual(open, vs)) {
      nextVs = opencodeWins ? open : vs;
      if (!opencodeWins) nextOpen = vs;
    }
    return { nextOpen, nextVs };
  }

  const openChanged = !deepEqual(open, previous.open);
  const vsChanged = !deepEqual(vs, previous.vs);

  if (openChanged && vsChanged) {
    if (!deepEqual(open, vs)) {
      if (opencodeWins) nextVs = open;
      else nextOpen = vs;
    }
  } else if (openChanged) {
    nextVs = open;
  } else if (vsChanged) {
    nextOpen = vs;
  } else if (!deepEqual(open, vs)) {
    // A previous write may have failed. Keep OpenCode authoritative.
    nextVs = open;
  }

  return { nextOpen, nextVs };
}

/**
 * Reduces value shapes that OpenCode and VS Code store differently. The model
 * can live in `opencode.json(c)` as `{ providerID, model, variant }`, while the
 * setting (and its dropdown) only holds `provider/model#variant`.
 */
function normalizeValue(meta, value) {
  if (!meta || meta.format !== 'model-ref') return value;
  if (typeof value === 'string' || value === undefined) return value;
  const compact = modelRefString(value);
  return compact === undefined ? value : compact;
}

function readSettingFromObject(object, meta) {
  // Machine settings are flat dotted keys; fall back to the legacy nested form.
  if (Object.prototype.hasOwnProperty.call(object || {}, meta.id)) {
    return object[meta.id];
  }
  const nested = getPath(object, [PREFIX, ...meta.path]);
  if (nested !== undefined) return nested;
  return undefined;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

class ApiVsSide {
  constructor(vscode, scopeUri, target, log) {
    this.vscode = vscode;
    this.scopeUri = scopeUri;
    this.target = target;
    this.log = log;
  }

  _configuration() {
    return this.vscode.workspace.getConfiguration(PREFIX, this.scopeUri);
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
      try {
        disposable.dispose();
      } catch {
        // Ignore.
      }
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
      try {
        watcher.dispose();
      } catch {
        // Ignore.
      }
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
      // `update`/`enterprise.url` are machine-wide; OpenCode ignores them in
      // project files and VS Code does not allow them at workspace scope.
      if (meta.scope === 'machine' && scope.kind !== 'global') continue;
      const open = normalizeValue(meta, getPath(openValue, meta.path));
      const vs = normalizeValue(meta, vsValues.get(meta.id));
      const ignoredKey = `${scope.id}:${meta.id}`;
      const ignored = this._ignored.get(ignoredKey);

      if (ignored && deepEqual(ignored.open, open)) {
        // Keep ignoring an incompatible OpenCode value, but clear its mirror.
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
            open: getPath(actualDocument.value || {}, meta.path),
            vs: actualVs.get(meta.id),
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

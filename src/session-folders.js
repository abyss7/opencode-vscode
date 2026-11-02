'use strict';

const UNGROUPED_ID = 'ungrouped';
const ARCHIVED_ID = 'archived';
const STORAGE_KEY = 'opencode.sessionFolders';
const MAX_FOLDER_LENGTH = 60;
const RESERVED_NAMES = new Set([
  UNGROUPED_ID,
  ARCHIVED_ID,
  'new folder',
]);

function normalizeFolderName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class SessionFolders {
  constructor(memento, key = STORAGE_KEY) {
    this._memento = memento || null;
    this._key = key;
  }

  _all() {
    if (!this._memento) return {};
    const value = this._memento.get(this._key, {});
    return isPlainObject(value) ? value : {};
  }

  _save(all) {
    if (this._memento) this._memento.update(this._key, all);
  }

  state(cwd) {
    const entry = this._all()[cwd];
    const folders = Array.isArray(entry && entry.folders)
      ? entry.folders.filter(
          (name) => typeof name === 'string' && name.length > 0
        )
      : [];
    const assignments = isPlainObject(entry && entry.assignments)
      ? { ...entry.assignments }
      : {};
    return { folders, assignments };
  }

  list(cwd) {
    return this.state(cwd).folders.slice();
  }

  validate(cwd, name) {
    const folder = normalizeFolderName(name);
    if (!folder) return 'Folder name cannot be empty.';
    if (folder.length > MAX_FOLDER_LENGTH) {
      return `Folder name must be ${MAX_FOLDER_LENGTH} characters or fewer.`;
    }
    if (RESERVED_NAMES.has(folder.toLowerCase())) {
      return `"${folder}" is a reserved folder name.`;
    }
    const existing = this.list(cwd);
    if (existing.some((item) => item.toLowerCase() === folder.toLowerCase())) {
      return `Folder "${folder}" already exists.`;
    }
    return null;
  }

  add(cwd, name) {
    const problem = this.validate(cwd, name);
    if (problem) throw new Error(problem);
    const folder = normalizeFolderName(name);
    const { folders, assignments } = this.state(cwd);
    const all = this._all();
    all[cwd] = { folders: [...folders, folder], assignments };
    this._save(all);
    return folder;
  }

  remove(cwd, name) {
    const { folders, assignments } = this.state(cwd);
    const next = folders.filter((item) => item !== name);
    if (next.length === folders.length) return false;
    const kept = {};
    for (const [sessionId, folder] of Object.entries(assignments)) {
      if (folder !== name) kept[sessionId] = folder;
    }
    const all = this._all();
    all[cwd] = { folders: next, assignments: kept };
    this._save(all);
    return true;
  }

  folderOf(cwd, sessionId) {
    const { folders, assignments } = this.state(cwd);
    const folder = assignments[sessionId];
    return folder && folders.includes(folder) ? folder : null;
  }

  assign(cwd, sessionId, folder) {
    const { folders, assignments } = this.state(cwd);
    if (folder) {
      if (!folders.includes(folder)) {
        throw new Error(`Unknown folder "${folder}".`);
      }
      assignments[sessionId] = folder;
    } else {
      delete assignments[sessionId];
    }
    const all = this._all();
    all[cwd] = { folders, assignments };
    this._save(all);
  }

  prune(cwd, sessionIds) {
    const { folders, assignments } = this.state(cwd);
    const valid = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
    let changed = false;
    for (const sessionId of Object.keys(assignments)) {
      if (!valid.has(sessionId)) {
        delete assignments[sessionId];
        changed = true;
      }
    }
    if (!changed) return false;
    const all = this._all();
    all[cwd] = { folders, assignments };
    this._save(all);
    return true;
  }
}

module.exports = {
  SessionFolders,
  UNGROUPED_ID,
  ARCHIVED_ID,
  STORAGE_KEY,
  MAX_FOLDER_LENGTH,
  normalizeFolderName,
};

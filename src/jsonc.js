'use strict';

const fs = require('node:fs');
const path = require('node:path');
const jsonc = require('./vendor/jsonc-parser/main');

const DEFAULT_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

function parse(text) {
  const errors = [];
  const value = jsonc.parse(String(text || ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const detail = errors
      .slice(0, 3)
      .map((error) => `offset ${error.offset}: ${error.error}`)
      .join(', ');
    throw new Error(`Invalid JSONC: ${detail}`);
  }
  return value === undefined || value === null ? {} : value;
}

function getPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(value, segments, next) {
  if (segments.length === 0) return next;
  let current = value;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return value;
    }
    if (current[segment] === null || typeof current[segment] !== 'object') {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = next;
  return value;
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function detectEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

function detectFormatting(text) {
  const eol = detectEol(text);
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([ \t]+)/);
    if (!match) continue;
    if (match[1].startsWith('\t')) {
      return { insertSpaces: false, tabSize: 1, eol };
    }
    return { insertSpaces: true, tabSize: match[1].length, eol };
  }
  return { ...DEFAULT_FORMAT, eol };
}

function formatOptions(text) {
  return detectFormatting(text);
}

/**
 * Apply a list of set/unset operations to a JSONC document. Comments,
 * trailing commas, key order, and unrelated keys are preserved.
 */
function applyOperations(text, operations, options = {}) {
  let current = String(text || '');
  if (current.trim() === '') {
    current = options.initial || '{}\n';
  }

  for (const operation of operations) {
    const pathSegments = Array.isArray(operation.path) ? operation.path : [];
    const edits = jsonc.modify(
      current,
      pathSegments,
      operation.unset ? undefined : operation.value,
      { formattingOptions: formatOptions(current) }
    );
    if (edits && edits.length > 0) {
      current = jsonc.applyEdits(current, edits);
    }
  }

  if (options.format === true) {
    const edits = [];
    jsonc.format(current, edits, {
      insertSpaces: true,
      tabSize: 2,
      eol: detectEol(current),
      keepLines: false,
    });
    if (edits.length > 0) {
      current = jsonc.applyEdits(current, edits);
    }
  }

  return current;
}

function atomicWrite(file, text, previousMode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: 'utf8' });
  if (previousMode !== undefined) {
    try {
      fs.chmodSync(temporary, previousMode);
    } catch {
      // Best effort.
    }
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    // Windows can refuse to replace an existing file.
    try {
      fs.unlinkSync(file);
      fs.renameSync(temporary, file);
    } catch (retryError) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Ignore.
      }
      throw retryError;
    }
  }
}

class JsoncStore {
  /**
   * @param {object} options
   * @param {object} [options.vscode] VS Code API, when running inside the extension host.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.vscode = options.vscode || null;
    this.log = options.log || (() => {});
    this._queues = new Map();
  }

  _enqueue(file, task) {
    const key = path.resolve(file);
    const previous = this._queues.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    this._queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  findOpenDocument(file) {
    if (!this.vscode) return null;
    const resolved = path.resolve(file);
    for (const document of this.vscode.workspace.textDocuments || []) {
      if (document.uri && document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === resolved) {
        return document;
      }
    }
    return null;
  }

  isDirty(file) {
    const document = this.findOpenDocument(file);
    return Boolean(document && document.isDirty);
  }

  readSync(file) {
    const document = this.findOpenDocument(file);
    if (document) {
      return { text: document.getText(), value: parse(document.getText()), exists: true, document };
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      return { text, value: parse(text), exists: true, document: null };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { text: '', value: {}, exists: false, document: null };
      }
      throw error;
    }
  }

  async read(file) {
    return this.readSync(file);
  }

  async write(file, operations, options = {}) {
    const resolved = path.resolve(file);
    return this._enqueue(resolved, async () => {
      const current = this.readSync(resolved);
      const text = current.exists ? current.text : options.initial || '';
      const nextText = applyOperations(text, operations, {
        initial: options.initial || this._initialFor(resolved, current),
        format: options.format === undefined ? !current.exists : options.format,
      });
      if (nextText === text) {
        return { changed: false, text };
      }
      if (nextText === current.text && current.exists) {
        return { changed: false, text: current.text };
      }

      const document = current.document;
      if (document) {
        await this._replaceDocument(document, nextText);
        return { changed: true, text: nextText };
      }

      let mode;
      try {
        mode = fs.statSync(resolved).mode;
      } catch {
        mode = undefined;
      }
      atomicWrite(resolved, nextText, mode);
      this.log(`Wrote ${resolved}`);
      return { changed: true, text: nextText };
    });
  }

  _initialFor(file, current) {
    if (current.exists) return '';
    if (path.basename(file) === 'opencode.json' || path.basename(file) === 'opencode.jsonc') {
      return '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    }
    return '{}\n';
  }

  async _replaceDocument(document, text) {
    const vscode = this.vscode;
    if (!vscode) throw new Error('VS Code API is not available');
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(document.uri, range, text);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`Failed to apply edits to ${document.uri.fsPath}`);
    }
    await document.save();
  }
}

module.exports = {
  JsoncStore,
  parse,
  getPath,
  setPath,
  deepEqual,
  applyOperations,
  atomicWrite,
};

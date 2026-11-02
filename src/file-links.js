'use strict';

const os = require('node:os');
const path = require('node:path');

const COLON_SUFFIX = /^(.*?):(\d+)(?::(\d+))?$/;
const HASH_SUFFIX = /^(.*?)#L(\d+)(?:C(\d+))?$/i;

function stripWrapping(value) {
  return String(value || '')
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '');
}

/**
 * Split a chat reference like `src/api.js:42`, `src/api.js:42:7`,
 * `src/api.js#L42` or a `file://` URL into a path and optional coordinates.
 */
function parseFileReference(value) {
  let raw = stripWrapping(value);
  if (!raw) return null;

  let line = null;
  let column = null;
  const hash = raw.match(HASH_SUFFIX);
  if (hash) {
    raw = hash[1];
    line = Number(hash[2]);
    column = hash[3] ? Number(hash[3]) : null;
  } else {
    const colon = raw.match(COLON_SUFFIX);
    if (colon) {
      raw = colon[1];
      line = Number(colon[2]);
      column = colon[3] ? Number(colon[3]) : null;
    }
  }

  raw = stripWrapping(raw);
  if (!raw) return null;

  if (/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  }

  return {
    path: raw,
    line: Number.isFinite(line) && line > 0 ? line : null,
    column: Number.isFinite(column) && column > 0 ? column : null,
  };
}

/**
 * True when `target` is equal to `base` or lies inside it. Rejects `..`
 * escapes and targets on a different root (e.g. another Windows drive).
 */
function isWithin(base, target) {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function resolveFileTarget(cwd, value) {
  const parsed = parseFileReference(value);
  if (!parsed) return null;

  const base = path.normalize(cwd || process.cwd());
  let target = parsed.path;
  if (target === '~') {
    target = os.homedir();
  } else if (target.startsWith('~/')) {
    target = path.join(os.homedir(), target.slice(2));
  } else if (!path.isAbsolute(target)) {
    target = path.resolve(base, target);
  }

  target = path.normalize(target);
  // A chat reference may point outside the workspace (prompt injection).
  // Only resolve paths that stay within the session directory.
  if (!isWithin(base, target)) return null;

  return {
    filePath: target,
    line: parsed.line,
    column: parsed.column,
  };
}

module.exports = {
  parseFileReference,
  resolveFileTarget,
};

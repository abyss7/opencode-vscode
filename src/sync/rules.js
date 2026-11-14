'use strict';

/**
 * @file Pure schema compatibility checks and three-way merge logic for
 * two-way synchronization between `opencode.json(c)` and VS Code settings.
 */

const path = require('node:path');
const { getPath, deepEqual } = require('../jsonc');
const { modelRefString } = require('../model-ref');

const PREFIX = 'opencode';

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

module.exports = {
  PREFIX,
  typeMatches,
  isCompatible,
  decideSync,
  normalizeValue,
  readSettingFromObject,
  samePath,
};

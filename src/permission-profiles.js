'use strict';

const path = require('node:path');
const fs = require('node:fs');

const VERSION = 3;
const EFFECTS = ['allow', 'ask', 'deny'];
const FALLBACKS = ['forbid', 'ask', 'smart', 'permit'];
const rank = { allow: 0, smart: 1, ask: 2, deny: 3 };
const rule = (action, resource, effect) => ({ action, resource, effect });
const reading = ['read', 'glob', 'grep', 'webfetch', 'websearch', 'skill', 'question', 'subagent', 'external_directory'];
const BUILTINS = {
  'read-only': {
    label: 'Read only', newActions: 'forbid',
    rules: [rule('*', '*', 'deny'), ...reading.map((action) => rule(action, '*', 'allow'))],
  },
  workspace: {
    label: 'Workspace', newActions: 'ask',
    rules: [
      ...reading.map((action) => rule(action, '*', 'allow')),
      rule('edit', '*', 'ask'), rule('edit', '${workspace}/*', 'allow'),
    ],
  },
  host: { label: 'Host', newActions: 'permit', rules: [rule('*', '*', 'allow')] },
  all: { label: 'All ⚠', newActions: 'permit', rules: [rule('*', '*', 'allow')] },
};

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateProfiles(profiles) {
  if (!object(profiles)) throw new Error('Permission profiles must be an object');
  for (const [id, profile] of Object.entries(profiles)) {
    if (!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(id) || !object(profile)) {
      throw new Error(`Invalid permission profile: ${id}`);
    }
    for (const key of Object.keys(profile)) {
      if (!['label', 'newActions', 'rules'].includes(key)) throw new Error(`Unknown profile field: ${id}.${key}`);
    }
    if (profile.label !== undefined && typeof profile.label !== 'string') throw new Error(`Invalid label: ${id}`);
    if (profile.newActions !== undefined && !FALLBACKS.includes(profile.newActions)) throw new Error(`Invalid newActions: ${id}`);
    if (profile.rules !== undefined && !Array.isArray(profile.rules)) throw new Error(`Invalid rules: ${id}`);
    for (const item of profile.rules || []) {
      if (!object(item) || typeof item.action !== 'string' || !item.action ||
          typeof item.resource !== 'string' || !item.resource || !EFFECTS.includes(item.effect) ||
          (item.match !== undefined && !['exact', 'glob'].includes(item.match)) ||
          Object.keys(item).some((key) => !['action', 'resource', 'effect', 'match'].includes(key))) {
        throw new Error(`Invalid permission rule in ${id}`);
      }
    }
  }
  return profiles;
}

function compileLayers(layers = []) {
  if (!Array.isArray(layers)) throw new Error('Permission layers must be an array');
  const result = Object.create(null);
  for (const layer of [{ name: 'Built-in', profiles: BUILTINS }, ...layers]) {
    if (!object(layer) || typeof layer.name !== 'string') throw new Error('Invalid permission layer');
    for (const [id, profile] of Object.entries(validateProfiles(layer.profiles))) {
      const compiled = result[id] || (result[id] = { id, label: id, newActions: 'ask', layers: [] });
      if (profile.label) compiled.label = profile.label;
      if (profile.newActions) compiled.newActions = profile.newActions;
      compiled.layers.push({ name: layer.name, rules: profile.rules || [] });
    }
  }
  return result;
}

function wildcard(value, pattern) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${expression}$`, process.platform === 'win32' ? 'i' : '').test(value);
}

// Resolve existing ancestors too: edits may create a file through a symlinked directory.
function canonical(file) {
  try { return fs.realpathSync.native(file); } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}

function resourceMatch(action, resource, pattern, cwd, match = 'glob') {
  const fileAction = ['read', 'edit', 'external_directory'].includes(action);
  let value = String(resource);
  let wanted = pattern;
  if (fileAction) {
    value = value.replace(/\\/g, '/');
    wanted = wanted.replace(/\\/g, '/');
  }
  if (fileAction && (wanted !== '*' || match === 'exact')) {
    const root = canonical(path.resolve(cwd)).replace(/\\/g, '/');
    value = canonical(path.resolve(cwd, value)).replace(/\\/g, '/');
    wanted = wanted.replace(/\$\{workspace\}/g, root);
    if (!path.isAbsolute(wanted)) wanted = `${root}/${wanted.replace(/^\.\//, '')}`;
    const wildcardAt = match === 'exact' ? -1 : wanted.search(/[?*]/);
    const boundary = wildcardAt < 0 ? wanted.length : wanted.lastIndexOf('/', wildcardAt);
    wanted = canonical(wanted.slice(0, boundary) || '/').replace(/\\/g, '/') + wanted.slice(boundary);
  }
  if (match === 'exact') return fileAction && process.platform === 'win32'
    ? value.toLowerCase() === wanted.toLowerCase() : value === wanted;
  if (wildcard(value, wanted)) return true;
  return action === 'shell' && wanted.endsWith(' *') && wildcard(value, wanted.slice(0, -2));
}

function evaluate(profile, fallback, action, resources, cwd, remembered = []) {
  if (!profile || !FALLBACKS.includes(fallback) || !Array.isArray(resources) || !resources.length) {
    return { effect: 'deny', reason: 'Invalid permission profile state' };
  }
  // Search permissions describe a query/glob, not every file visited. Avoid leaking
  // restricted files through search (or unrestricted interpreters) in this prototype.
  const restrictedRead = [...profile.layers, { name: 'Project rules', rules: remembered }].some((layer) => layer.name !== 'Built-in' &&
    layer.rules.some((item) => wildcard('read', item.action) && item.effect !== 'allow'));
  if (restrictedRead && ['glob', 'grep', 'shell', 'execute'].includes(action)) {
    return { effect: 'deny', reason: 'Read restrictions require direct file reads; search and arbitrary execution are blocked' };
  }
  let effect = 'allow';
  let reason = '';
  let unmatched = false;
  for (const resource of resources) {
    let decision = null;
    let source = '';
    for (const layer of profile.layers) {
      // Within one layer: normal ordered rules. Across layers: restrictive intersection.
      const match = layer.rules.filter((item) => wildcard(action, item.action) &&
        resourceMatch(action, resource, item.resource, cwd, item.match)).at(-1);
      if (match && (!decision || rank[match.effect] > rank[decision])) {
        decision = match.effect;
        source = `${layer.name}: ${match.action} ${match.resource}`;
      }
    }
    // Remembered choices answer ordinary asks, but cannot override a profile deny.
    const saved = remembered.filter((item) => wildcard(action, item.action) &&
      resourceMatch(action, resource, item.resource, cwd, item.match)).at(-1);
    if (saved && decision !== 'deny') {
      decision = saved.effect;
      source = `Project rules (${profile.id}): ${saved.action} ${saved.resource} → ${saved.effect}`;
    }
    if (!decision) {
      unmatched = true;
      decision = { forbid: 'deny', ask: 'ask', smart: 'smart', permit: 'allow' }[fallback];
      source = `Without a rule: ${fallback}`;
    }
    if (rank[decision] >= rank[effect]) { effect = decision; reason = source; }
  }
  return { effect, reason, unmatched };
}

function selectProfile(state, profiles, selected, fallback) {
  const id = selected || state.selected || 'workspace';
  if (!Object.hasOwn(profiles, id)) throw new Error(`Unknown permission profile: ${id}`);
  const choices = { ...(state.choices || {}) };
  if (fallback !== undefined && !FALLBACKS.includes(fallback)) throw new Error('Invalid new-actions mode');
  choices[id] = id === 'read-only' ? 'forbid' : ['all', 'host'].includes(id) ? 'permit'
    : fallback || choices[id] || profiles[id].newActions;
  return { ...state, selected: id, choices };
}

module.exports = { VERSION, BUILTINS, FALLBACKS, compileLayers, evaluate, selectProfile, wildcard, canonical, validateProfiles };

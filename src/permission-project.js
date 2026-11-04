'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Installed beside the plugin under these names; also used directly by the extension.
const engine = require('./permission-profiles');

const filename = (cwd) => path.join(cwd, '.opencode', 'permission-rules.json');
const empty = () => ({ version: 1, profiles: {} });

function validate(document) {
  if (!document || document.version !== 1 || Object.keys(document).some((key) => !['version', 'profiles'].includes(key))) {
    throw new Error('Expected permission rules { version: 1, profiles: { ... } }');
  }
  engine.validateProfiles(document.profiles);
  for (const profile of Object.values(document.profiles)) {
    if (Object.keys(profile).some((key) => key !== 'rules')) throw new Error('Project profiles only accept rules');
  }
  return document;
}

function read(cwd) {
  try { return validate(JSON.parse(fs.readFileSync(filename(cwd), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw new Error(`Cannot read ${filename(cwd)}: ${error.message}`);
  }
}

function ensure(cwd) {
  const target = filename(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, JSON.stringify(empty(), null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return target;
}

function withRules(document, profile, rules) {
  const old = document.profiles[profile]?.rules || [];
  const same = (a, b) => a.action === b.action && a.resource === b.resource && (a.match || 'glob') === (b.match || 'glob');
  return validate({ ...document, profiles: { ...document.profiles, [profile]: {
    rules: [...old.filter((item) => !rules.some((rule) => same(item, rule))), ...rules],
  } } });
}

function write(cwd, document) {
  validate(document);
  const target = filename(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function choices(request, cwd) {
  const resources = [...new Set(request.resources)];
  if (!resources.length || resources.some((item) => typeof item !== 'string' || !item || item === '*')) return [];
  // Opaque tools expose '*' rather than the executed code; never call that an exact command.
  if (!['read', 'edit', 'shell', 'webfetch', 'websearch', 'skill', 'subagent'].includes(request.action)) return [];
  const fileAction = ['read', 'edit'].includes(request.action);
  const root = engine.canonical(path.resolve(cwd));
  const portable = (file) => {
    const relative = path.relative(root, file);
    return relative === '' ? '${workspace}' : !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
      ? '${workspace}/' + relative.split(path.sep).join('/') : file.split(path.sep).join('/');
  };
  const files = fileAction ? resources.map((resource) => engine.canonical(path.resolve(cwd, resource))) : [];
  const exact = fileAction ? files.map(portable) : resources;
  const make = (resource, match) => ({ action: request.action, resource, match });
  const result = [{ id: 'exact', label: fileAction ? 'These exact files' : request.action === 'shell'
    ? 'These exact commands' : 'These exact resources', rules: exact.map((resource) => make(resource, 'exact')) }];
  if (fileAction) {
    const dirs = [...new Set(files.map((file) => path.dirname(file)))];
    // Do not turn literal wildcard characters in directory names into broader access.
    if (dirs.every((dir) => !/[?*]/.test(dir))) result.push({ id: 'directory', label: 'Containing directories and their contents',
      rules: dirs.flatMap((dir) => [make(portable(dir), 'exact'), make(portable(dir).replace(/\/$/, '') + '/*', 'glob')]) });
  }
  return result;
}

module.exports = { filename, read, ensure, withRules, write, choices, validate };

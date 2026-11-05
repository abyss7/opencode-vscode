'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('./jsonc');
const engine = require('./permission-profiles');

// Read on each evaluation so edits apply to already running ACP runtimes too.
function read(directory) {
  const rules = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(directory, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const permissions = parse(text).permissions;
    if (permissions === undefined) continue;
    if (!Array.isArray(permissions)) throw new Error(`Expected V2 permissions array in ${file}`);
    engine.validateProfiles({ global: { rules: permissions } });
    rules.push(...permissions.map((rule) => ({ ...rule, file })));
  }
  return rules;
}

function match(rules, action, resource, cwd) {
  return rules.filter((rule) => {
    let pattern = rule.resource;
    if (['read', 'edit', 'external_directory'].includes(action)) {
      pattern = pattern.replace(/^(~|\$HOME)(?=\/|$)/, () => os.homedir());
    }
    return engine.wildcard(action, rule.action) &&
      engine.resourceMatch(action, resource, pattern, cwd);
  }).at(-1);
}

module.exports = { read, match };

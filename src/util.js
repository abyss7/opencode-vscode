'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command name against PATH plus well-known OpenCode install dirs.
 * VS Code launched from a desktop environment often has a shorter PATH than an
 * interactive shell, so `opencode` may live in ~/.opencode/bin without being
 * visible to the extension host.
 */
function resolveCommand(command) {
  const value = String(command || '').trim();
  if (!value) return 'opencode';

  if (value.includes('/') || value.includes('\\')) {
    return value;
  }

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  const directories = [];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (directory) directories.push(directory);
  }
  directories.push(
    path.join(os.homedir(), '.opencode', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin'
  );

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, value + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return value;
}

module.exports = { resolveCommand };

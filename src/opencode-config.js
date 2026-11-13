'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'];

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function directoryExists(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function platformConfigDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'opencode');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'opencode');
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

function localConfigCandidates() {
  const candidates = [];
  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(path.resolve(process.env.OPENCODE_CONFIG_DIR));
  }
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'opencode'));
  }
  candidates.push(path.join(os.homedir(), '.config', 'opencode'));
  candidates.push(platformConfigDir());
  return [...new Set(candidates)];
}

/**
 * Ask the installed CLI for its config directory. This respects the same
 * environment overrides as OpenCode itself. It does not start the service.
 */
async function resolveConfigDirFromCli(command) {
  if (!command) return null;
  try {
    const { stdout } = await execFileAsync(command, ['debug', 'paths'], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    const clean = String(stdout).replace(/\u001b\[[0-9;]*m/g, '');
    const match = clean.match(/^\s*config\s+(.+?)\s*$/m);
    if (!match) return null;
    return path.resolve(match[1]);
  } catch {
    return null;
  }
}

async function resolveGlobalConfigDir(options = {}) {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  }

  const fromCli = await resolveConfigDirFromCli(options.command);
  if (fromCli) return fromCli;

  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  }

  const candidates = localConfigCandidates();
  for (const candidate of candidates) {
    if (directoryExists(candidate)) return candidate;
  }
  return candidates[0] || platformConfigDir();
}

function configFilesIn(directory) {
  return CONFIG_NAMES.map((name) => path.join(directory, name));
}

function findConfigFile(directory) {
  const files = configFilesIn(directory).filter(fileExists);
  return files.length > 0 ? files[files.length - 1] : null;
}

function findConfigFiles(directory) {
  return configFilesIn(directory).filter(fileExists);
}

/**
 * The file OpenCode would use for a project directory. Existing files win;
 * when both JSON and JSONC exist, the JSONC file has the higher priority.
 */
function projectConfigFile(directory) {
  const direct = findConfigFile(directory);
  const dotDirectory = path.join(directory, '.opencode');
  const dot = findConfigFile(dotDirectory);
  if (dot) return dot;
  if (direct) return direct;
  return path.join(directory, 'opencode.jsonc');
}

function ancestors(directory) {
  const resolved = path.resolve(directory);
  const result = [];
  let current = resolved;
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

/**
 * All configuration files OpenCode discovers for a directory, lowest priority
 * first: direct files from the outermost ancestor to the directory, then
 * `.opencode` files in the same order.
 */
function discoverProjectConfigFiles(directory) {
  const directories = ancestors(directory).reverse();
  const direct = [];
  const dot = [];
  for (const dir of directories) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fileExists(file)) direct.push(file);
    }
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, '.opencode', name);
      if (fileExists(file)) dot.push(file);
    }
  }
  return [...direct, ...dot];
}

function machineSettingsCandidates() {
  const candidates = [];
  if (process.env.VSCODE_AGENT_FOLDER) {
    candidates.push(
      path.join(process.env.VSCODE_AGENT_FOLDER, 'data', 'Machine', 'settings.json')
    );
  }
  candidates.push(
    path.join(os.homedir(), '.vscode-server', 'data', 'Machine', 'settings.json')
  );
  candidates.push(
    path.join(os.homedir(), '.vscode-server-insiders', 'data', 'Machine', 'settings.json')
  );
  return [...new Set(candidates)];
}

function machineSettingsFile() {
  for (const candidate of machineSettingsCandidates()) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function isRemoteWindow(vscode) {
  return Boolean(vscode && vscode.env && vscode.env.remoteName);
}

module.exports = {
  CONFIG_NAMES,
  fileExists,
  directoryExists,
  platformConfigDir,
  localConfigCandidates,
  resolveGlobalConfigDir,
  resolveConfigDirFromCli,
  configFilesIn,
  findConfigFile,
  findConfigFiles,
  projectConfigFile,
  discoverProjectConfigFiles,
  ancestors,
  machineSettingsCandidates,
  machineSettingsFile,
  isRemoteWindow,
};

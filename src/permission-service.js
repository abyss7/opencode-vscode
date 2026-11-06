'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveGlobalConfigDir } = require('./opencode-config');
const { compileLayers, VERSION } = require('./permission-profiles');
const project = require('./permission-project');

// Different keys deliberately preserve User and Host ceilings. VS Code's public
// inspect API does not expose user-local and user-remote values separately.
function readLayers(vscode, cwd) {
  const config = vscode.workspace.getConfiguration('opencodeSessions', vscode.Uri.file(cwd));
  const inspect = (key) => config.inspect(key) || {};
  const workspace = inspect('workspacePermissionProfiles');
  const layers = [
    { name: 'User', profiles: inspect('permissionProfiles').globalValue || {} },
    { name: 'Host / Remote', profiles: inspect('hostPermissionProfiles').globalValue || {} },
    { name: 'Workspace', profiles: workspace.workspaceValue || {} },
    { name: 'Folder', profiles: workspace.workspaceFolderValue || {} },
  ];
  compileLayers(layers);
  return layers;
}

class PermissionService {
  constructor({ vscode, api, command, log }) {
    this.vscode = vscode;
    this.api = api;
    this.command = command;
    this.log = log;
    this.installation = null;
  }

  async install() {
    if (!this.installation) this.installation = this._install().catch((error) => {
      this.installation = null;
      throw error;
    });
    return this.installation;
  }

  async _install() {
    const config = await resolveGlobalConfigDir({ command: this.command });
    const agents = path.join(config, 'agents');
    await fs.mkdir(agents, { recursive: true });
    // This becomes a user-owned instruction file: never replace an existing agent.
    const classifier = await fs.readFile(path.join(__dirname, '../agents/permission-classifier.md'), 'utf8');
    await fs.writeFile(path.join(agents, 'permission-classifier.md'), classifier, { flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const target = path.join(config, 'plugins', 'vscode-permission-profiles');
    await fs.mkdir(target, { recursive: true });
    const sources = {
      'index.ts': path.join(__dirname, '../plugins/permission-profiles/index.ts'),
      'runtime.cjs': path.join(__dirname, '../plugins/permission-profiles/runtime.cjs'),
      'classifier.cjs': path.join(__dirname, '../plugins/permission-profiles/classifier.cjs'),
      'bridge.cjs': path.join(__dirname, '../plugins/permission-profiles/bridge.cjs'),
      'session-temp.cjs': path.join(__dirname, '../plugins/permission-profiles/session-temp.cjs'),
      'engine.cjs': path.join(__dirname, 'permission-profiles.js'),
      'project.cjs': path.join(__dirname, 'permission-project.js'),
      'global.cjs': path.join(__dirname, 'permission-global.js'),
      'jsonc.js': path.join(__dirname, 'jsonc.js'),
    };
    for (const file of ['main.js', 'impl/edit.js', 'impl/scanner.js', 'impl/format.js', 'impl/parser.js', 'impl/string-intern.js']) {
      sources[`vendor/jsonc-parser/${file}`] = path.join(__dirname, 'vendor/jsonc-parser', file);
    }
    const contentsByName = {};
    for (const [name, source] of Object.entries(sources)) contentsByName[name] = await fs.readFile(source, 'utf8');
    contentsByName['project.cjs'] = contentsByName['project.cjs'].replace("require('./permission-profiles')", "require('./engine.cjs')");
    contentsByName['global.cjs'] = contentsByName['global.cjs'].replace("require('./permission-profiles')", "require('./engine.cjs')");
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(contentsByName)).digest('hex');
    contentsByName['index.ts'] += `\n// Bundle fingerprint: ${fingerprint}\n`;
    // Entry point last; its fingerprint reloads the plugin when a dependency changes.
    for (const name of [...Object.keys(sources).filter((name) => name !== 'index.ts'), 'index.ts']) {
      const contents = contentsByName[name];
      const destination = path.join(target, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const previous = await fs.readFile(destination, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (contents !== previous) await fs.writeFile(destination, contents);
    }
    this.log(`Permission profiles plugin: ${target}`);
    return target;
  }

  async ready(cwd) {
    await this.install();
    let last;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await this.api.permissionProfiles('status', {}, cwd);
        if (response.version !== VERSION) throw new Error('Permission plugin version mismatch');
        return;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`Permission profiles plugin is unavailable: ${last.message}`);
  }

  async configure(sessionID, cwd, agent, change = {}) {
    const config = this.vscode.workspace.getConfiguration('opencodeSessions', this.vscode.Uri.file(cwd));
    const defaults = config.get('agentPermissionProfiles', {});
    return this.api.permissionProfiles('configure', {
      sessionID, layers: readLayers(this.vscode, cwd),
      agentProfiles: defaults,
      smartTimeoutMs: config.get('smartTimeoutSeconds', 30) * 1000,
      allowSessionTemp: config.get('allowSessionTemp', true),
      sessionTempBaseDirectory: config.get('sessionTempBaseDirectory', ''),
      defaultProfile: defaults[agent] || config.get('defaultPermissionProfile', 'workspace'),
      ...change,
    }, cwd);
  }

  async _request(method, input, cwd) {
    const output = await this.api.permissionProfiles(method, input, cwd);
    if (output?.error) throw new Error(output.error.message);
    return output;
  }

  describe(sessionID, cwd, toolCallId) {
    return this._request('describe', { sessionID, toolCallId }, cwd);
  }

  remember(sessionID, cwd, toolCallId, details, choiceId, effect) {
    return this._request('remember', {
      sessionID, toolCallId, permissionId: details.permissionId, revision: details.revision, owner: details.owner, choiceId, effect,
    }, cwd);
  }

  async openRules(cwd) {
    const file = project.ensure(cwd);
    const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(file));
    await this.vscode.window.showTextDocument(document);
  }
}

module.exports = { PermissionService, readLayers };

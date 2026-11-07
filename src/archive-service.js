'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveGlobalConfigDir } = require('./opencode-config');
const { VERSION } = require('../plugins/archive/runtime.cjs');

class ArchiveService {
  constructor({ api, command, log }) {
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
    const target = path.join(config, 'plugins', 'vscode-archive');
    await fs.mkdir(target, { recursive: true });
    const sources = {
      'hook.ts': path.join(__dirname, '../plugins/archive/hook.ts'),
      'runtime.cjs': path.join(__dirname, '../plugins/archive/runtime.cjs'),
      'README.md': path.join(__dirname, '../plugins/archive/README.md'),
      'index.ts': path.join(__dirname, '../plugins/archive/index.ts'),
    };
    const contents = {};
    for (const [name, source] of Object.entries(sources)) contents[name] = await fs.readFile(source, 'utf8');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(contents)).digest('hex');
    contents['index.ts'] += `\n// Bundle fingerprint: ${fingerprint}\n`;
    for (const name of ['hook.ts', 'runtime.cjs', 'README.md', 'index.ts']) {
      const destination = path.join(target, name);
      const previous = await fs.readFile(destination, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (contents[name] !== previous) await fs.writeFile(destination, contents[name]);
    }
    this.log(`Archive plugin: ${target}`);
    return target;
  }

  async ready(cwd) {
    await this.install();
    let last;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await this.api.archiveIntegration('status', {}, cwd);
        if (response.version !== VERSION) throw new Error('Archive plugin version mismatch');
        return;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`Archive plugin is unavailable: ${last.message}`);
  }

  async archive(sessionID, cwd) {
    let commandError;
    try {
      await this.ready(cwd);
      await this.api.runCommand(sessionID, 'archive', '', { delivery: 'queue' });
    } catch (error) {
      commandError = error;
    }

    // OpenCode 2.2.5 accepts ctx.session.update({ archived: true }) from a
    // plugin but does not persist it. The HTTP update is also the guarantee
    // that a missing or failed hook never prevents archiving.
    await this.api.updateSession(sessionID, { archived: true });
    if (commandError) this.log(`Before-archive command failed for ${sessionID}; archived anyway: ${commandError.message}`);
    return { commandError };
  }
}

module.exports = { ArchiveService };

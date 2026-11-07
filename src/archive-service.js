'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveGlobalConfigDir } = require('./opencode-config');
const { VERSION } = require('../plugins/archive/runtime.cjs');

class ArchiveService {
  constructor({ api, command, log, pollInterval = 250 }) {
    this.api = api;
    this.command = command;
    this.log = log;
    this.pollInterval = pollInterval;
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
    // Archiving is the user-visible operation. Finalization deliberately starts
    // only after the server has persisted this state and never delays the UI.
    await this.api.updateSession(sessionID, { archived: true });
    return { finalization: this._afterArchive(sessionID, cwd) };
  }

  async getFinalization(sessionID, cwd) {
    await this.ready(cwd);
    const response = await this.api.archiveIntegration('status', { sessionID }, cwd);
    return response.finalization || null;
  }

  async waitForFinalization(sessionID, cwd, initial) {
    let state = initial || await this.getFinalization(sessionID, cwd);
    let failures = 0;
    while (state?.state === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
      try {
        state = await this.getFinalization(sessionID, cwd);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= 40) throw error;
      }
    }
    return state;
  }

  async _afterArchive(sessionID, cwd) {
    try {
      await this.ready(cwd);
      const response = await this.api.archiveIntegration('afterArchive', { sessionID }, cwd);
      return await this.waitForFinalization(sessionID, cwd, response.finalization);
    } catch (error) {
      this.log(`After-archive finalization failed for ${sessionID}: ${error.message}`);
      return { archivedAt: 0, state: 'failed', error: error.message || String(error) };
    }
  }
}

module.exports = { ArchiveService };

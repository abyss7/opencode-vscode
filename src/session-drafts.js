'use strict';

const fs = require('node:fs');
const path = require('node:path');

class SessionDrafts {
  constructor(directory, log = () => {}) {
    this.directory = directory;
    this.log = log;
  }

  file(sessionId) {
    return this.directory && /^ses_[\w-]+$/.test(sessionId)
      ? path.join(this.directory, `${sessionId}.txt`) : null;
  }

  read(sessionId) {
    const file = this.file(sessionId);
    if (!file) return '';
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.log(`Cannot read composer draft (${error.code})`);
      return '';
    }
  }

  save(sessionId, text) {
    const file = this.file(sessionId);
    if (!file) return;
    if (!text) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') this.log(`Cannot remove composer draft (${error.code})`);
      }
      return;
    }

    // Commit each received edit immediately, without a shutdown hook or timer.
    // A process killed during the write leaves the previous snapshot intact.
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, text, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      this.log(`Cannot save composer draft (${error.code})`);
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}

module.exports = { SessionDrafts };

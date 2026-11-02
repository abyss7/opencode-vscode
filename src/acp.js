'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const REQUEST_TIMEOUT_MS = 30000;

// Custom ACP extensions agreed with the agent. A client that advertises
// child-session updates receives sub-agent output on a separate notification;
// without it the agent folds child updates into the parent session's stream,
// which corrupts the parent transcript.
const CHILD_SESSION_UPDATES = 'opencode/child-session-updates';
const CHILD_UPDATE_METHOD = 'opencode/session/child_update';

class AcpClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || 'opencode';
    this.cwd = options.cwd;
    this.env = options.env;
    this.log = options.log || (() => {});

    this.child = null;
    this.sessionId = null;
    this.configOptions = [];
    this.capabilities = null;

    this._buffer = '';
    this._nextId = 1;
    this._pending = new Map();
    this._closed = false;
    this._intentionalClose = false;
    this._startPromise = null;
  }

  get closed() {
    return this._closed;
  }

  start() {
    if (!this._startPromise) {
      this._startPromise = this._spawnAndInitialize();
    }
    return this._startPromise;
  }

  /**
   * Parameters for the ACP `initialize` request. The `_meta` entry tells the
   * agent that this client can take child-session updates out of band, so
   * sub-agent output never lands in the parent session's transcript.
   */
  initializeParams() {
    return {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
      _meta: { [CHILD_SESSION_UPDATES]: true },
    };
  }

  async _spawnAndInitialize() {
    this.log(`Spawning: ${this.command} acp (cwd: ${this.cwd})`);
    const child = spawn(this.command, ['acp'], {
      cwd: this.cwd,
      env: { ...process.env, ...(this.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdin.on('error', (error) => {
      this.log(`ACP stdin error: ${error.message}`);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.log(`[acp stderr] ${text}`);
    });

    child.on('error', (error) => {
      this.log(`ACP process error: ${error.message}`);
      this._closed = true;
      this._rejectAll(error);
      if (!this._intentionalClose) this.emit('exit', { error });
    });

    child.on('exit', (code, signal) => {
      this.log(`ACP process exited: code=${code} signal=${signal}`);
      this._closed = true;
      this._rejectAll(
        new Error(`OpenCode ACP process exited (code=${code}, signal=${signal || 'none'})`)
      );
      if (!this._intentionalClose) this.emit('exit', { code, signal });
    });

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
        this.removeListener('disposed', onDispose);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onDispose = () => {
        cleanup();
        reject(new Error('OpenCode tab was closed'));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      this.once('disposed', onDispose);
    });

    const initialized = await this._request(
      'initialize',
      this.initializeParams(),
      REQUEST_TIMEOUT_MS
    );
    this.capabilities = initialized && initialized.agentCapabilities ? initialized.agentCapabilities : null;
    this.log(
      `ACP initialized: ${JSON.stringify(
        initialized && initialized.agentInfo ? initialized.agentInfo : {}
      )}`
    );
    return initialized;
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    for (;;) {
      const index = this._buffer.indexOf('\n');
      if (index < 0) break;
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.log(`Invalid JSON from ACP: ${line.slice(0, 500)}`);
      return;
    }

    if (
      message.id !== undefined &&
      message.id !== null &&
      (Object.prototype.hasOwnProperty.call(message, 'result') ||
        Object.prototype.hasOwnProperty.call(message, 'error'))
    ) {
      this._handleResponse(message);
      return;
    }

    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        this._handleAgentRequest(message);
      } else {
        this._handleNotification(message);
      }
    }
  }

  _handleResponse(message) {
    const pending = this._pending.get(message.id);
    if (!pending) {
      this.log(`Response for unknown request id ${message.id}`);
      return;
    }
    this._pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (message.error) {
      const error = new Error(
        message.error.message || `ACP error ${message.error.code || ''}`.trim()
      );
      error.code = message.error.code;
      error.data = message.error.data;
      if (error.code === -32000) {
        error.message += '. Run "opencode auth login" in a terminal.';
      }
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  _handleNotification(message) {
    if (!message.params) return;
    if (message.method === CHILD_UPDATE_METHOD) {
      this.emit('childUpdate', message.params);
      return;
    }
    if (message.method !== 'session/update') return;
    const update = message.params.update || {};
    if (update.sessionUpdate === 'session_info_update' && update.title) {
      this.emit('title', update.title);
    }
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      this.configOptions = update.configOptions;
      this.emit('configOptions', this.configOptions);
    }
    this.emit('update', message.params);
  }

  _handleAgentRequest(message) {
    if (message.method === 'session/request_permission') {
      const params = message.params || {};
      const options = Array.isArray(params.options) ? params.options : [];
      let answered = false;

      const respond = (optionId) => {
        if (answered) return;
        answered = true;
        const result = optionId
          ? { outcome: { outcome: 'selected', optionId } }
          : { outcome: { outcome: 'cancelled' } };
        this._respond(message.id, result);
      };

      if (this.listenerCount('permission') === 0) {
        respond(null);
        return;
      }

      this.emit('permission', {
        requestId: message.id,
        sessionId: params.sessionId,
        toolCall: params.toolCall || null,
        options,
        respond,
      });
      return;
    }

    if (message.method === 'elicitation/create') {
      const params = message.params || {};
      let answered = false;

      const respond = (action, content) => {
        if (answered) return;
        answered = true;
        if (action === 'accept') {
          this._respond(message.id, { action: 'accept', content: content || null });
        } else if (action === 'decline') {
          this._respond(message.id, { action: 'decline' });
        } else {
          this._respond(message.id, { action: 'cancel' });
        }
      };

      if (params.mode !== 'form' || this.listenerCount('elicitation') === 0) {
        respond('cancel');
        return;
      }

      this.emit('elicitation', {
        requestId: message.id,
        sessionId: params.sessionId,
        toolCallId: params.toolCallId || null,
        mode: params.mode,
        message: params.message || '',
        requestedSchema: params.requestedSchema || null,
        respond,
      });
      return;
    }

    this._respondError(
      message.id,
      -32601,
      `Client does not support method ${message.method}`
    );
  }

  _respond(id, result) {
    try {
      this._send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.log(`Failed to send response ${id}: ${error.message}`);
    }
  }

  _respondError(id, code, message) {
    try {
      this._send({ jsonrpc: '2.0', id, error: { code, message } });
    } catch (error) {
      this.log(`Failed to send error response ${id}: ${error.message}`);
    }
  }

  _send(message) {
    if (!this.child || this._closed || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('OpenCode ACP process is not running');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new Error('OpenCode ACP process has already exited'));
        return;
      }
      const id = this._nextId++;
      const entry = { method, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this._pending.delete(id)) {
            reject(new Error(`ACP request timed out: ${method}`));
          }
        }, timeoutMs);
      }
      this._pending.set(id, entry);
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this._pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error);
      }
    });
  }

  _rejectAll(error) {
    for (const [id, pending] of this._pending) {
      this._pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  async newSession() {
    const result = await this._request(
      'session/new',
      { cwd: this.cwd, mcpServers: [] },
      REQUEST_TIMEOUT_MS
    );
    this.sessionId = result.sessionId;
    this.configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    return result;
  }

  async loadSession(sessionId) {
    this.sessionId = sessionId;
    const result = await this._request(
      'session/load',
      { sessionId, cwd: this.cwd, mcpServers: [] },
      REQUEST_TIMEOUT_MS
    );
    this.configOptions =
      result && Array.isArray(result.configOptions) ? result.configOptions : this.configOptions;
    return result;
  }

  async prompt(prompt) {
    if (!this.sessionId) throw new Error('Session has not been created yet');
    const blocks =
      typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
    return this._request(
      'session/prompt',
      {
        sessionId: this.sessionId,
        prompt: Array.isArray(blocks) ? blocks : [],
      },
      0
    );
  }

  cancel() {
    if (!this.sessionId) return;
    try {
      this._send({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this.sessionId },
      });
    } catch (error) {
      this.log(`Failed to cancel: ${error.message}`);
    }
  }

  async setConfigOption(configId, value) {
    if (!this.sessionId) throw new Error('Session has not been created yet');
    const result = await this._request(
      'session/set_config_option',
      { sessionId: this.sessionId, configId, value },
      REQUEST_TIMEOUT_MS
    );
    if (result && Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions;
    }
    return this.configOptions;
  }

  dispose() {
    if (this._intentionalClose) return;
    this._intentionalClose = true;
    this._rejectAll(new Error('OpenCode tab was closed'));
    // Wake up any start() awaiting the spawn event so it does not hang.
    this.emit('disposed');
    const child = this.child;
    if (!child) return;
    try {
      if (child.stdin && child.stdin.writable) child.stdin.end();
    } catch {
      // Ignore.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore.
    }
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        // Ignore.
      }
    }, 1500);
    if (timer.unref) timer.unref();
  }
}

module.exports = { AcpClient };

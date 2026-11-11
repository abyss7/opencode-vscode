'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { sessionActivity } = require('./session-activity');
const { BackgroundRuns } = require('./background-runs');

const execFileAsync = promisify(execFile);
const USERNAME = 'opencode';
const SERVICE_TTL_MS = 15000;

function readServicePassword() {
  const candidates = [];
  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(process.env.OPENCODE_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'opencode'));
  }
  candidates.push(path.join(os.homedir(), '.config', 'opencode'));
  candidates.push(path.join(os.homedir(), '.opencode'));
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'opencode'));
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'opencode'));
  }

  for (const dir of candidates) {
    const file = path.join(dir, 'service.json');
    try {
      if (!fs.existsSync(file)) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value && typeof value.password === 'string' && value.password) {
        return value.password;
      }
    } catch {
      // Ignore a malformed service file and try the next location.
    }
  }
  return null;
}

class OpenCodeApi {
  constructor(options = {}) {
    this.command = options.command || 'opencode';
    this.log = options.log || (() => {});
    this._server = null;
    this._serverAt = 0;
    this._localSessions = new Map();
    this._activeRead = null;
    this._activeAt = 0;
    this.background = new BackgroundRuns(this);
  }

  setCommand(command) {
    if (command && command !== this.command) {
      this.command = command;
      this._server = null;
      this._serverAt = 0;
      this._activeRead = null;
    }
  }

  async _readStatus() {
    const { stdout } = await execFileAsync(this.command, ['service', 'status'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const match = String(stdout).match(/https?:\/\/[^\s]+/);
    if (!match) {
      throw new Error(`opencode service status returned an unexpected response: ${String(stdout).trim()}`);
    }
    return match[0].replace(/\/+$/, '');
  }

  async _resolveServer(force = false) {
    if (!force && this._server && Date.now() - this._serverAt < SERVICE_TTL_MS) {
      return this._server;
    }

    let url;
    try {
      url = await this._readStatus();
    } catch (firstError) {
      this.log(`OpenCode server is not running, starting it: ${firstError.message}`);
      try {
        await execFileAsync(this.command, ['service', 'start'], {
          timeout: 20000,
          maxBuffer: 1024 * 1024,
        });
        url = await this._readStatus();
      } catch (startError) {
        throw new Error(
          `Failed to connect to the OpenCode server. Check the "${this.command}" command ` +
            `and run "opencode service start". ${startError.message}`
        );
      }
    }

    this._server = { url, password: readServicePassword() };
    this._serverAt = Date.now();
    return this._server;
  }

  _rawRequest(server, method, pathname, body) {
    const url = new URL(pathname, server.url);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (server.password) {
      headers.authorization =
        'Basic ' + Buffer.from(`${USERNAME}:${server.password}`, 'utf8').toString('base64');
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        { method, headers, timeout: 20000 },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (!raw) {
                resolve(null);
                return;
              }
              try {
                resolve(JSON.parse(raw));
              } catch {
                resolve(raw);
              }
              return;
            }
            const error = new Error(
              `${method} ${url.pathname} -> HTTP ${res.statusCode}` +
                (raw ? `: ${raw.slice(0, 500)}` : '')
            );
            error.statusCode = res.statusCode;
            reject(error);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('OpenCode request timed out')));
      req.on('error', reject);
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async _request(method, pathname, body, retried = false) {
    const server = await this._resolveServer();
    try {
      return await this._rawRequest(server, method, pathname, body);
    } catch (error) {
      const retryable =
        !retried &&
        (error.code === 'ECONNREFUSED' ||
          error.code === 'ECONNRESET' ||
          error.code === 'EPIPE' ||
          error.statusCode === 401);
      if (!retryable) throw error;
      this.log(`Request failed, re-resolving OpenCode server: ${error.message}`);
      this._server = null;
      await this._resolveServer(true);
      return this._request(method, pathname, body, true);
    }
  }

  async listSessions(directory, options = {}) {
    const archived = options.archived === true;
    const query = new URLSearchParams({
      directory,
      parentID: 'null',
      archived: archived ? 'true' : 'false',
      limit: '200',
      order: 'desc',
    });

    let response;
    try {
      response = await this._request('GET', `/api/session?${query.toString()}`);
    } catch (error) {
      this.log(`Filtered session list failed (${error.message}), falling back to full list`);
      if (archived) return [];
      response = await this._request('GET', '/api/session');
    }

    const sessions = Array.isArray(response && response.data) ? response.data : [];
    return this._withActivity(sessions
      .filter((session) => {
        const dir = session && session.location && session.location.directory;
        if (dir !== directory) return false;
        if (session.parentID) return false;
        if (!archived && session.archived) return false;
        return true;
      })
      .sort(
        (a, b) =>
          ((b.time && (b.time.updated || b.time.created)) || 0) -
          ((a.time && (a.time.updated || a.time.created)) || 0)
      ));
  }

  setSessionRunning(sessionId, owner, running) {
    if (!sessionId) return;
    const owners = this._localSessions.get(sessionId) || new Set();
    if (running) owners.add(owner);
    else owners.delete(owner);
    if (owners.size) this._localSessions.set(sessionId, owners);
    else this._localSessions.delete(sessionId);
  }

  async _withActivity(sessions) {
    // The shared service only reports its own executions. Local ACP prompts
    // are owned by separate servers; absence in both sources remains unknown
    // when durable busy intent exists (another window may own the session).
    if (!this._activeRead || Date.now() - this._activeAt >= 2000) {
      this._activeAt = Date.now();
      this._activeRead = this._request('GET', '/api/session/active')
        .then((response) => {
          if (!response?.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
            throw new Error('Invalid active session response');
          }
          return response.data;
        })
        .catch((error) => {
          this.log(`Live session activity unavailable: ${error.message}`);
          return null;
        });
    }
    const active = await this._activeRead;
    return sessions.map((session) => ({
      ...session,
      _activity: this._localSessions.has(session.id) || active?.[session.id]?.type === 'running'
        ? 'running' : sessionActivity(session),
    }));
  }

  /**
   * Sub-agent sessions for a directory: child sessions whose `parentID`
   * points at another session. `listSubagents(cwd)` returns every child in the
   * directory; `listSubagents(cwd, sessionId)` narrows the request to the
   * children of one session. Returns `null` when the request failed, so a
   * transient error cannot blank a list the caller already has.
   */
  async listSubagents(directory, parentId) {
    const query = new URLSearchParams({
      directory,
      archived: 'false',
      limit: '200',
      order: 'desc',
    });
    if (parentId) query.set('parentID', parentId);
    let response;
    try {
      response = await this._request('GET', `/api/session?${query.toString()}`);
    } catch (error) {
      this.log(`Sub-agent list failed (${error.message})`);
      return null;
    }
    const sessions = Array.isArray(response && response.data) ? response.data : [];
    return this._withActivity(sessions.filter((session) => {
      const dir = session && session.location && session.location.directory;
      if (dir !== directory) return false;
      if (!session.parentID) return false;
      if (parentId && session.parentID !== parentId) return false;
      return true;
    }));
  }

  async updateSession(sessionId, patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('updateSession requires a patch object');
    }
    await this._request(
      'PATCH',
      `/api/session/${encodeURIComponent(sessionId)}`,
      patch
    );
  }

  async getSession(sessionId) {
    const response = await this._request(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}`
    );
    if (!response?.data) return null;
    return (await this._withActivity([response.data]))[0];
  }

  async interruptSession(sessionId) {
    await this._request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
    this._activeRead = null;
  }

  async listMessages(sessionId, options = {}) {
    const query = new URLSearchParams();
    query.set('limit', String(options.limit || 20));
    query.set('order', options.order || 'desc');
    if (options.cursor) query.set('cursor', options.cursor);
    const response = await this._request(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`
    );
    return Array.isArray(response && response.data) ? response.data : [];
  }

  /**
   * Full message history. The endpoint caps each page at 200 messages, so walk
   * `next` until the server stops returning a cursor.
   */
  async listAllMessages(sessionId, options = {}) {
    const pageLimit = options.pageLimit || 200;
    const limit = options.limit || 1000;
    const order = options.order || 'asc';
    const messages = [];
    let cursor = null;
    for (;;) {
      const query = new URLSearchParams();
      query.set('limit', String(pageLimit));
      // The API rejects a cursor combined with an explicit order: the cursor
      // already carries the direction of the first request.
      if (cursor) query.set('cursor', cursor);
      else query.set('order', order);
      const response = await this._request(
        'GET',
        `/api/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`
      );
      const page = response && Array.isArray(response.data) ? response.data : [];
      messages.push(...page);
      const cursorInfo = response && response.cursor;
      cursor =
        cursorInfo && typeof cursorInfo.next === 'string' ? cursorInfo.next : null;
      if (!cursor || page.length === 0 || messages.length >= limit) break;
    }
    return messages.slice(0, limit);
  }

  async getMessage(sessionId, messageId) {
    const response = await this._request(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`
    );
    return response && response.data ? response.data : null;
  }

  async listModels(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/model${suffix}`);
    return Array.isArray(response && response.data) ? response.data : [];
  }

  /** Resolved server default, including provider fallback when no model is configured. */
  async getDefaultModel(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/model/default${suffix}`);
    return response?.data ?? null;
  }

  /** Agents available for a directory, including hidden internal ones. */
  async listAgents(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/agent${suffix}`);
    return Array.isArray(response && response.data) ? response.data : [];
  }

  async permissionProfiles(method, input, directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const response = await this._request('POST',
      `/api/rpc/vscode-permission-profiles/${encodeURIComponent(method)}?${query}`, { input });
    return response && response.output;
  }

  async archiveIntegration(method, input, directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const response = await this._request('POST',
      `/api/rpc/vscode-archive/${encodeURIComponent(method)}?${query}`, { input });
    return response && response.output;
  }

  async deleteSession(sessionId) {
    await this._request('DELETE', `/api/session/${encodeURIComponent(sessionId)}`);
  }

  async listSkills(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/skill${suffix}`);
    const items = Array.isArray(response && response.data) ? response.data : [];
    return items
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .map((item) => ({
        id: item.id,
        name: typeof item.name === 'string' && item.name ? item.name : item.id,
        description:
          typeof item.description === 'string' ? item.description : '',
      }));
  }

  async listCommands(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/command${suffix}`);
    const items = Array.isArray(response && response.data) ? response.data : [];
    return items
      .filter((item) => item && typeof item.name === 'string' && item.name)
      .map((item) => ({
        name: item.name,
        description:
          typeof item.description === 'string' ? item.description : '',
      }));
  }

  async runCommand(sessionId, name, text, options = {}) {
    const body = { name, text: text || '' };
    if (options.delivery) body.delivery = options.delivery;
    await this._request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/command`,
      body
    );
  }

  /**
   * Send a prompt to a session. When the session is busy, `delivery` decides
   * how the request is handled: "queue" runs it after the current turn, while
   * "steer" redirects the running agent.
   */
  async prompt(sessionId, text, options = {}) {
    const body = { text };
    if (options.delivery) body.delivery = options.delivery;
    const response = await this._request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      body
    );
    return response && response.data ? response.data : response;
  }

  async compactSession(sessionId) {
    await this._request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/compact`,
      {}
    );
  }

  // Connection metadata is public; no credential export is needed for the footer.
  async getChatGPTSubscription(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/integration/openai${suffix}`);
    const connections = response && response.data && response.data.connections;
    return (
      Array.isArray(connections) &&
      connections.length > 0 &&
      connections.every(
        (item) => item.type === 'credential' && item.method === 'oauth' && !item.status
      )
    );
  }

  async getUsageLimits(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request(
      'GET',
      `/api/experimental/usage/limits${suffix}`
    );
    return response && response.data ? response.data : null;
  }

  /**
   * Configuration documents for a directory, lowest priority first. Each entry
   * holds the raw `info` from that file, so later entries override earlier ones.
   */
  async getConfig(directory) {
    const query = new URLSearchParams();
    if (directory) query.set('location[directory]', directory);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this._request('GET', `/api/config${suffix}`);
    return Array.isArray(response)
      ? response
      : Array.isArray(response && response.data)
        ? response.data
        : [];
  }
}

module.exports = {
  OpenCodeApi,
  readServicePassword,
};

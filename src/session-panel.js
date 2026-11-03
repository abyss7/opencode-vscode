'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { AcpClient } = require('./acp');
const { resolveFileTarget } = require('./file-links');
const { getBalance } = require('./balance');
const { buildTurnStats, estimatePartTokens } = require('./turn-stats');
const {
  usageTotal,
  matchModel,
  parseModelRef,
  resolveBudget,
  modelPrices,
  splitStepCost,
  summarizeCost,
} = require('./usage');

const HTML_PATH = path.join(__dirname, '..', 'media', 'chat.html');

// A live sub-agent entry outlives its last ACP update so the strip does not
// flicker between polls; the REST poller prunes it afterwards.
const SUBAGENT_LIVE_TTL_MS = 15000;
const SUBAGENT_LIVE_BUSY_MS = 4000;

function buildHtml(webview, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat.js')
  );

  return fs
    .readFileSync(HTML_PATH, 'utf8')
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{richTextUri\}\}/g, String(webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'rich-text.js')
    )))
    .replace(/\{\{styleUri\}\}/g, String(styleUri))
    .replace(/\{\{scriptUri\}\}/g, String(scriptUri));
}

/**
 * Effective compaction settings from the config documents OpenCode reported
 * for a directory. Later documents override earlier ones.
 */
function readCompaction(documents) {
  const compaction = {};
  for (const document of Array.isArray(documents) ? documents : []) {
    const info = document && document.info;
    const value = info && info.compaction;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.auto === 'boolean') compaction.auto = value.auto;
    if (typeof value.buffer === 'number' && Number.isFinite(value.buffer)) {
      compaction.buffer = value.buffer;
    }
  }
  return compaction;
}

/**
 * A sub-agent session counts as running while `busy` is newer than `idle`.
 * Mirrors `isBusy` in sessions-view.js.
 */
function isRunning(session) {
  const time = (session && session.time) || {};
  if (!time.busy) return false;
  return !time.idle || time.idle < time.busy;
}

/**
 * Friendly label for the tool a sub-agent is currently using. Falls back to
 * the raw tool name for anything unknown.
 */
function subagentAction(name) {
  switch (name) {
    case 'bash':
    case 'shell':
    case 'execute':
      return 'run';
    case 'read':
      return 'read';
    case 'edit':
      return 'edit';
    case 'write':
      return 'write';
    case 'grep':
    case 'glob':
      return 'search';
    case 'task':
      return 'sub-agent';
    case 'webfetch':
      return 'fetch';
    default:
      return name || 'working';
  }
}

/**
 * The action label implied by a child-session update, or '' when the update
 * says nothing about what the sub-agent is doing right now.
 */
function childUpdateAction(update) {
  if (!update || typeof update !== 'object') return '';
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update':
      return subagentAction(update.kind || update.name || '');
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return 'working';
    default:
      return '';
  }
}


class SessionPanel {
  constructor(options) {
    this.panel = options.panel;
    this.deps = options.deps;
    this.sessionId = options.sessionId || null;
    this.cwd = options.cwd;

    this._client = null;
    this._started = false;
    this._disposed = false;
    this._cleanedUp = false;
    this._busy = false;
    this._queuedCount = 0;
    this._sessionTitle = null;
    this._modelRef = null;
    this._modelLimit = null;
    this._limits = null;
    this._compaction = null;
    this._balanceErrorLogged = false;
    this._costSteps = new Map();
    this._costPrices = null;
    this._costPricesAt = 0;
    this._sessionCost = 0;
    this._costSplitPosted = '';
    this._permissions = new Map();
    this._elicitations = new Map();
    this._metadataTimers = [];
    this._limitsTimer = null;
    this._subagentsTimer = null;
    this._subagentsRefreshing = false;
    this._subagentsCache = new Map();
    this._subagentsPolled = new Map();
    this._subagentsLive = new Map();
    this._subagentsSignature = '';
    this._missingSessionIdLogged = false;
    this._disposables = [];

    this.panel.webview.html = buildHtml(this.panel.webview, this.deps.extensionUri);
    this._iconKind = null;
    this._setIcon('idle');
    if (this.sessionId) {
      this.panel.title = 'OpenCode';
    } else {
      this.panel.title = 'New Session';
    }

    this._disposables.push(
      this.panel.webview.onDidReceiveMessage((message) => this._onMessage(message))
    );
    this._disposables.push(this.panel.onDidDispose(() => this._cleanup()));
    if (typeof this.panel.onDidChangeViewState === 'function') {
      this._disposables.push(
        this.panel.onDidChangeViewState((event) => this._onViewState(event))
      );
    }

    if (this.sessionId) {
      this._refreshMetadata(0);
    }
  }

  get disposed() {
    return this._disposed;
  }

  reveal() {
    if (this._disposed) return;
    this.panel.reveal();
    this._focusIfActive();
  }

  _setIcon(kind) {
    if (this._disposed || this._iconKind === kind) return;
    this._iconKind = kind;
    if (kind === 'working') {
      this.panel.iconPath = this._iconUri('opencode-working.svg');
    } else if (kind === 'done') {
      this.panel.iconPath = this._iconUri('opencode-done.svg');
    } else {
      this.panel.iconPath = {
        light: this._iconUri('opencode-light.svg'),
        dark: this._iconUri('opencode-dark.svg'),
      };
    }
  }

  _iconUri(file) {
    return vscode.Uri.joinPath(this.deps.extensionUri, 'media', file);
  }

  _onViewState(event) {
    if (this._disposed) return;
    const panel = (event && event.webviewPanel) || this.panel;
    if (!panel || !panel.active) return;
    if (this._iconKind === 'done') this._setIcon('idle');
    this._focusIfActive();
  }

  _focusIfActive() {
    if (this._disposed) return;
    if (this.panel.active === false) return;
    this._post({ type: 'focus' });
    // The webview may still be hidden while the panel is being revealed, so ask
    // again once it has been laid out.
    this._trackTimeout(() => {
      if (!this._disposed && this.panel.active !== false) {
        this._post({ type: 'focus' });
      }
    }, 80);
  }

  /**
   * Schedule a timeout that is cleared on cleanup and removed from
   * `_metadataTimers` once it fires, so the array does not grow forever.
   */
  _trackTimeout(fn, delay) {
    const timer = setTimeout(() => {
      this._removeTimer(timer);
      fn();
    }, delay);
    if (timer.unref) timer.unref();
    this._metadataTimers.push(timer);
    return timer;
  }

  _removeTimer(timer) {
    const index = this._metadataTimers.indexOf(timer);
    if (index >= 0) this._metadataTimers.splice(index, 1);
  }

  _startTurn() {
    this._busy = true;
    this._setIcon('working');
    this._post({ type: 'status', state: 'busy' });
    this._refreshSubagents();
  }

  _finishTurn(state) {
    this._busy = false;
    const done = state === 'ready' && this.panel.active !== true;
    this._setIcon(done ? 'done' : 'idle');
    this._post({ type: 'status', state });
  }

  _post(message) {
    if (this._disposed) return;
    this.panel.webview.postMessage(message).then(undefined, (error) => {
      this.deps.log(`Webview postMessage failed: ${error.message}`);
    });
  }

  _onMessage(message) {
    if (this._disposed || !message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        if (this._sessionTitle) {
          this._post({ type: 'sessionInfo', title: this._sessionTitle });
        }
        this._resendSubagents();
        this._start();
        break;
      case 'prompt':
        this._prompt(
          String(message.text || ''),
          Array.isArray(message.images) ? message.images : []
        );
        break;
      case 'command':
        this._runCommand(
          String(message.name || ''),
          String(message.text || '')
        );
        break;
      case 'openSession':
        this._openSession(String(message.sessionId || ''));
        break;
      case 'cancel':
        this._cancel();
        break;
      case 'permissionResponse':
        this._answerPermission(message.requestId, message.optionId || null);
        break;
      case 'elicitationResponse':
        this._answerElicitation(
          message.requestId,
          message.action === 'accept' || message.action === 'decline'
            ? message.action
            : 'cancel',
          message.content || null
        );
        break;
      case 'setConfigOption':
        this._setConfigOption(String(message.configId || ''), String(message.value || ''));
        break;
      case 'openExternal':
        this._openExternal(String(message.url || ''));
        break;
      case 'openFile':
        this._openFile(
          String(message.path || ''),
          Number(message.line) || null,
          Number(message.column) || null
        );
        break;
      case 'checkFiles':
        this._checkFiles(Array.isArray(message.files) ? message.files : []);
        break;
      default:
        this.deps.log(`Unknown webview message: ${message.type}`);
    }
  }

  async _start() {
    if (this._started || this._disposed) return;
    this._started = true;
    this._post({ type: 'status', state: 'connecting' });

    const config = this.deps.getConfig();
    const client = new AcpClient({
      command: config.command,
      cwd: this.cwd,
      log: this.deps.log,
    });
    this._client = client;

    client.on('update', (params) => this._onAcpUpdate(params));
    client.on('childUpdate', (params) => this._onChildUpdate(params));
    client.on('permission', (request) => this._onPermission(request));
    client.on('elicitation', (request) => this._onElicitation(request));
    client.on('title', (title) => this._onTitle(title));
    client.on('configOptions', (options) => {
      this._post({ type: 'config', configOptions: options });
      this._syncModelOptions(options);
    });
    client.on('exit', (info) => this._onExit(info));

    try {
      await client.start();
      if (this._disposed) return;
      this._post({
        type: 'capabilities',
        images: Boolean(
          client.capabilities &&
            client.capabilities.promptCapabilities &&
            client.capabilities.promptCapabilities.image
        ),
      });

      if (this.sessionId) {
        await client.loadSession(this.sessionId);
        if (this._disposed) return;
        this._post({
          type: 'session',
          sessionId: this.sessionId,
          cwd: this.cwd,
          loaded: true,
        });
      } else {
        const result = await client.newSession();
        this.sessionId = result.sessionId;
        if (this._disposed) {
          this.deps.onSessionCreated(this, result.sessionId, this.cwd);
          return;
        }
        this.panel.title = 'New Session';
        this._post({
          type: 'session',
          sessionId: this.sessionId,
          cwd: this.cwd,
          loaded: false,
        });
        this.deps.onSessionCreated(this, this.sessionId, this.cwd);
      }

      this._post({ type: 'config', configOptions: client.configOptions || [] });
      this._syncModelOptions(client.configOptions || []);
      this._post({ type: 'historyEnd' });
      this._loadSlashItems();
      this._trackTimeout(() => this._loadSlashItems(), 3000);
      this._post({ type: 'status', state: 'ready' });
      this._focusIfActive();
      this._refreshLimits();
      this._refreshCompaction();
      this._refreshUsageFromHistory();
      this._refreshBalance(true);
      this._restoreTurnStats();
      this._startLimitsTimer();
      this._startSubagentsPolling();
    } catch (error) {
      this.deps.log(`ACP start failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'status', state: 'error' });
      this._post({ type: 'error', message: this._friendlyError(error, config.command) });
    }
  }

  _friendlyError(error, command) {
    if (error && error.code === 'ENOENT') {
      return (
        `OpenCode executable "${command}" was not found. ` +
        'Set the full path in the "opencodeSessions.command" setting.'
      );
    }
    return error && error.message ? error.message : String(error);
  }

  _onAcpUpdate(params) {
    if (this._disposed) return;
    const incoming = params && params.sessionId;
    if (this.sessionId && incoming && incoming !== this.sessionId) {
      return;
    }
    if (this.sessionId && !incoming && !this._missingSessionIdLogged) {
      this._missingSessionIdLogged = true;
      this.deps.log(
        'ACP session/update without sessionId; rendering it in the current tab'
      );
    }
    this._post({ type: 'update', update: params.update || {} });
  }

  _onPermission(request) {
    if (this._disposed) {
      request.respond(null);
      return;
    }

    const config = this.deps.getConfig();
    if (config.autoApprovePermissions === 'allowAll') {
      const option =
        request.options.find((item) => String(item.kind || '').startsWith('allow')) ||
        request.options.find((item) => /allow|approve/i.test(String(item.name || '')));
      request.respond(option ? option.optionId : null);
      const title =
        (request.toolCall && request.toolCall.title) || 'action';
      this._post({
        type: 'info',
        text: option
          ? `Automatically allowed: ${title}`
          : `Permission request denied: ${title}`,
      });
      return;
    }

    this._permissions.set(request.requestId, request);
    this._post({
      type: 'permission',
      requestId: request.requestId,
      toolCall: request.toolCall,
      options: request.options,
    });
  }

  _answerPermission(requestId, optionId) {
    const request = this._permissions.get(requestId);
    if (!request) return;
    this._permissions.delete(requestId);
    request.respond(optionId);
  }

  _onElicitation(request) {
    if (this._disposed) {
      request.respond('cancel');
      return;
    }
    this._elicitations.set(request.requestId, request);
    this._post({
      type: 'elicitation',
      requestId: request.requestId,
      toolCallId: request.toolCallId || null,
      message: request.message,
      requestedSchema: request.requestedSchema,
    });
  }

  _answerElicitation(requestId, action, content) {
    const request = this._elicitations.get(requestId);
    if (!request) return;
    this._elicitations.delete(requestId);
    request.respond(action, content);
  }

  applyTitle(title) {
    if (this._disposed || !title) return;
    this._sessionTitle = title;
    this.panel.title = title;
    this._post({ type: 'sessionInfo', title });
  }

  _onTitle(title) {
    if (this._disposed || !title) return;
    this.applyTitle(title);
    this.deps.onSessionChanged();
  }

  async _prompt(text, images) {
    const value = text.trim();
    const blocks = [];
    if (value) blocks.push({ type: 'text', text: value });
    for (const image of Array.isArray(images) ? images : []) {
      if (!image || typeof image.data !== 'string' || !image.data) continue;
      if (
        typeof image.mimeType !== 'string' ||
        !image.mimeType.startsWith('image/')
      ) {
        continue;
      }
      blocks.push({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      });
    }
    if (blocks.length === 0 || !this._client || !this.sessionId) {
      return;
    }

    // ACP has no way to send a second prompt while a turn is running, so route
    // busy-time submissions through the REST endpoint as a queued request.
    if (this._busy) {
      await this._queuePrompt(value);
      return;
    }

    this._startTurn();

    let stopReason = null;
    let usage = null;
    let promptError = null;
    try {
      const result = await this._client.prompt(blocks);
      if (this._disposed) return;
      stopReason = result && result.stopReason;
      usage = result && result.usage;
    } catch (error) {
      this.deps.log(`Prompt failed: ${error.stack || error.message}`);
      promptError = error;
    }

    if (this._disposed) return;
    const alive = this._client && !this._client.closed;
    if (!alive) {
      this._post({ type: 'turnEnd', stopReason: 'error' });
      this._finishTurn('error');
      this._afterTurn();
      return;
    }

    if (promptError) {
      this._post({ type: 'turnEnd', stopReason: 'error' });
      this._post({
        type: 'error',
        message: promptError.message || String(promptError),
      });
      this._finishTurn('ready');
      this._afterTurn();
      return;
    }

    // A queued request keeps the tab busy until the server has drained it, so
    // skip the normal turnEnd and let _drainQueue reload the transcript.
    if (this._queuedCount > 0) {
      await this._drainQueue();
    } else {
      this._post({ type: 'turnEnd', stopReason, usage });
      this._finishTurn('ready');
    }
    this._afterTurn();
  }

  _afterTurn() {
    this.deps.onSessionChanged();
    this._refreshMetadata(800);
    this._refreshMetadata(3000);
    this._refreshSessionUsage();
    this._refreshModelContext();
    this._refreshLimits();
    this._refreshCompaction();
    this._refreshBalance();
    this._refreshLastTurnStats();
    this._refreshSubagents();
  }

  async _queuePrompt(text) {
    if (!this.sessionId || !text) return;
    this._queuedCount += 1;
    try {
      await this.deps.api.prompt(this.sessionId, text, { delivery: 'queue' });
      if (this._disposed) return;
      this._post({
        type: 'info',
        text: 'Queued — will run after the current turn.',
      });
    } catch (error) {
      this._queuedCount = Math.max(0, this._queuedCount - 1);
      this.deps.log(`Queue prompt failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'error', message: error.message || String(error) });
    }
  }

  /**
   * Wait for queued requests to finish on the server, then reload the
   * transcript. ACP does not stream turns it did not initiate, so the only way
   * to see a queued turn's output is a full reload once the session is idle.
   */
  async _drainQueue() {
    if (this._disposed || !this._client || !this.sessionId) return;
    while (
      this._queuedCount > 0 &&
      !this._disposed &&
      this._client &&
      !this._client.closed
    ) {
      this._queuedCount = 0;
      const finished = await this._waitForIdle();
      if (this._disposed) return;
      if (!finished) {
        this._post({
          type: 'info',
          text: 'Queued requests are still running on the OpenCode server; reopen the tab later to see the result.',
        });
        break;
      }
      try {
        await this._reloadTranscript();
      } catch (error) {
        this.deps.log(`Reload after queue failed: ${error.stack || error.message}`);
        break;
      }
    }
    if (this._disposed) return;
    this._finishTurn(this._client && !this._client.closed ? 'ready' : 'error');
  }

  async _loadSlashItems() {
    if (this._disposed) return;
    const [skills, commands] = await Promise.all([
      this.deps.api.listSkills(this.cwd).catch((error) => {
        this.deps.log(`Failed to load skills: ${error.message}`);
        return [];
      }),
      this.deps.api.listCommands(this.cwd).catch((error) => {
        this.deps.log(`Failed to load commands: ${error.message}`);
        return [];
      }),
    ]);
    if (this._disposed) return;
    this._post({ type: 'slashItems', skills, commands });
  }

  async _runCommand(name, text) {
    const command = name.replace(/^\/+/, '').trim();
    if (!command || !this.sessionId || !this._client || this._busy) return;

    this._startTurn();

    try {
      if (command === 'compact') {
        await this.deps.api.compactSession(this.sessionId);
      } else {
        await this.deps.api.runCommand(this.sessionId, command, text);
      }
      const finished = await this._waitForIdle();
      if (this._disposed) return;
      await this._reloadTranscript();
      if (finished) {
        this._post({ type: 'info', text: `Ran /${command}.` });
      } else {
        this._post({
          type: 'info',
          text: `/${command} is still running on the OpenCode server; reopen the tab later to see the rest.`,
        });
      }
    } catch (error) {
      this.deps.log(`Command /${command} failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'error', message: error.message || String(error) });
      this._post({ type: 'turnEnd', stopReason: 'error' });
      this._finishTurn('ready');
      return;
    }

    if (this._disposed) return;
    this._busy = false;
    this._post({ type: 'turnEnd', stopReason: 'end_turn' });
    this._finishTurn('ready');
    this.deps.onSessionChanged();
    this._refreshMetadata(800);
    this._refreshSessionUsage();
    this._refreshLimits();
    this._refreshCompaction();
    this._refreshBalance();
  }

  async _waitForIdle(timeoutMs = 600000) {
    const started = Date.now();
    for (;;) {
      if (this._disposed) return false;
      let info = null;
      try {
        info = await this.deps.api.getSession(this.sessionId);
      } catch (error) {
        this.deps.log(`Failed to poll session state: ${error.message}`);
      }
      const time = (info && info.time) || {};
      const busy = Number(time.busy) || 0;
      const idle = Number(time.idle) || 0;
      if (Date.now() - started > 2500 && idle >= busy) return true;
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  async _reloadTranscript() {
    if (this._disposed || !this._client || !this.sessionId) return;
    this._post({ type: 'historyReset' });
    await this._client.loadSession(this.sessionId);
    if (this._disposed) return;
    this._post({ type: 'historyEnd' });
    this._post({ type: 'config', configOptions: this._client.configOptions || [] });
    this._syncModelOptions(this._client.configOptions || []);
    this._refreshUsageFromHistory();
    this._restoreTurnStats();
    this._refreshBalance();
  }

  _cancel() {
    if (!this._client || !this._busy) return;
    this._post({ type: 'status', state: 'cancelling' });
    for (const request of this._elicitations.values()) {
      try {
        request.respond('cancel');
      } catch {
        // Ignore.
      }
    }
    this._elicitations.clear();
    this._client.cancel();
  }

  /**
   * Open another session (for example a sub-agent) in its own tab.
   */
  _openSession(sessionId) {
    if (this._disposed || !sessionId) return;
    if (typeof this.deps.openSession === 'function') {
      this.deps.openSession(sessionId, this.cwd);
    }
  }

  async _setConfigOption(configId, value) {
    if (!this._client || !configId || !value) return;
    try {
      const options = await this._client.setConfigOption(configId, value);
      if (this._disposed) return;
      this._post({ type: 'config', configOptions: options || [] });
      this._syncModelOptions(options || []);
    } catch (error) {
      this.deps.log(`setConfigOption failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'error', message: error.message || String(error) });
      this._post({
        type: 'config',
        configOptions: this._client.configOptions || [],
      });
    }
  }

  _openExternal(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
  }

  _baseDir() {
    if (this.cwd) return this.cwd;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0 && folders[0].uri) {
      return folders[0].uri.fsPath;
    }
    return process.cwd();
  }

  _checkFiles(files) {
    const base = this._baseDir();
    const results = [];
    for (const item of files) {
      const key = item && typeof item.key === 'string' ? item.key : null;
      if (!key) continue;
      const target = resolveFileTarget(base, item.path);
      let exists = false;
      if (target) {
        try {
          exists = fs.statSync(target.filePath).isFile();
        } catch {
          exists = false;
        }
      }
      results.push({ key, exists });
    }
    this._post({ type: 'fileChecks', files: results });
  }

  async _openFile(reference, line, column) {
    const target = resolveFileTarget(this._baseDir(), reference);
    if (!target) return;

    const lineNumber = line || target.line;
    const columnNumber = column || target.column;
    const options = {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
      preserveFocus: false,
    };

    if (lineNumber) {
      const position = new vscode.Position(
        Math.max(0, lineNumber - 1),
        Math.max(0, (columnNumber || 1) - 1)
      );
      options.selection = new vscode.Range(position, position);
    }

    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(target.filePath)
      );
      if (this._disposed) return;
      await vscode.window.showTextDocument(document, options);
    } catch (error) {
      // A chat reference may point at a file that does not exist; ignore it.
      this.deps.log(`Failed to open ${target.filePath}: ${error.message}`);
    }
  }

  async _refreshLimits() {
    if (this._disposed) return;
    try {
      const limits = await this.deps.api.getUsageLimits(this.cwd);
      if (this._disposed) return;
      this._limits = limits;
      this._post({
        type: 'limits',
        limits,
        budget: resolveBudget(limits, this._modelRef),
      });
    } catch (error) {
      this.deps.log(`Failed to load usage limits: ${error.message}`);
    }
  }

  async _refreshCompaction() {
    if (this._disposed) return;
    try {
      const documents = await this.deps.api.getConfig(this.cwd);
      if (this._disposed) return;
      this._compaction = readCompaction(documents);
      this._post({ type: 'compaction', compaction: this._compaction });
    } catch (error) {
      this.deps.log(`Failed to load compaction config: ${error.message}`);
    }
  }

  /**
   * Adopt the model selected in the ACP config bar immediately, before the
   * server reports its own selection in the session info.
   */
  _syncModelOptions(options) {
    if (!Array.isArray(options)) return;
    const option = options.find((item) => item && item.category === 'model');
    if (!option) return;
    const ref = parseModelRef(option.currentValue);
    if (ref) this._setModelRef(ref);
  }

  _setModelRef(ref, force = false) {
    if (!ref || !ref.providerID || !ref.id) return;
    const previous = this._modelRef;
    const next = {
      providerID: ref.providerID,
      id: ref.id,
      inputPrice: previous && previous.inputPrice,
    };
    if (ref.variant) next.variant = ref.variant;
    const changed =
      !previous ||
      previous.providerID !== next.providerID ||
      previous.id !== next.id ||
      (next.variant || '') !== (previous.variant || '');
    this._modelRef = next;
    if (!changed && !force) return;
    this._refreshModelContext().then(() => {
      if (!this._disposed) this._refreshLimits();
    });
    this._refreshBalance(true);
  }

  /**
   * Provider-declared context and input windows for the selected model, plus
   * its input price, which the Console budget match needs.
   */
  async _refreshModelContext() {
    const ref = this._modelRef;
    if (this._disposed || !ref) return;
    try {
      const models = await this.deps.api.listModels(this.cwd);
      if (this._disposed) return;
      const record = matchModel(models, ref);
      const context = Number(record && record.limit && record.limit.context) || 0;
      const input = Number(record && record.limit && record.limit.input) || 0;
      const price = Number(
        record &&
          Array.isArray(record.cost) &&
          record.cost[0] &&
          record.cost[0].input
      );
      this._modelLimit = { context, input };
      if (this._modelRef) {
        this._modelRef.inputPrice = Number.isFinite(price) ? price : undefined;
      }
      this._post({
        type: 'modelLimit',
        context,
        input,
        model: { providerID: ref.providerID, id: ref.id },
      });
    } catch (error) {
      this.deps.log(`Failed to resolve model limits: ${error.message}`);
    }
  }

  async _refreshBalance(force = false) {
    if (this._disposed) return;
    const ref = this._modelRef;
    if (!ref || !ref.providerID) return;
    try {
      const balance = await getBalance(ref.providerID, {
        command: this.deps.getConfig().command,
        force,
      });
      if (this._disposed) return;
      this._post({ type: 'balance', balance: balance || null });
      this._balanceErrorLogged = false;
    } catch (error) {
      if (!this._balanceErrorLogged) {
        this._balanceErrorLogged = true;
        this.deps.log(
          `Failed to load balance for ${ref.providerID}: ${error.message}`
        );
      }
      if (this._disposed) return;
      this._post({ type: 'balance', balance: null });
    }
  }

  /**
   * Session-level cost, and the model in case it changed outside the config
   * bar. ACP reports usage once per turn; this keeps the line correct even
   * when the server omits its own `usage_update`.
   */
  async _refreshSessionUsage() {
    if (this._disposed || !this.sessionId) return;
    try {
      const info = await this.deps.api.getSession(this.sessionId);
      if (this._disposed || !info) return;
      if (info.model) this._setModelRef(info.model);
      if (typeof info.cost === 'number') {
        this._sessionCost = info.cost;
        this._post({
          type: 'update',
          update: {
            sessionUpdate: 'usage_update',
            cost: { amount: info.cost, currency: 'USD' },
          },
        });
        this._postCostSplit();
      }
    } catch (error) {
      this.deps.log(`Failed to refresh session usage: ${error.message}`);
    }
  }

  /**
   * Per-tariff spending for the cost tooltip. The server stores the billed cost
   * of every step, so each step is accounted once with the prices of its own
   * model: peak-hour rates and model switches stay honoured. Steps the API no
   * longer lists (pre-compaction history) are covered by scaling the collected
   * shares up to the stored session cost.
   */
  async _accountCosts(messages) {
    if (this._disposed || !this.sessionId) return;
    const steps = (Array.isArray(messages) ? messages : []).filter(
      (message) => message && message.type === 'assistant' && message.tokens
    );
    if (steps.length === 0) return;
    let prices = null;
    for (const message of steps) {
      const cached = this._costSteps.get(message.id);
      if (cached && cached.cost === message.cost) continue;
      if (!prices) {
        prices = await this._resolvePrices();
        if (this._disposed) return;
      }
      const model = message.model || {};
      const step = splitStepCost(
        message.tokens,
        prices.get(`${model.providerID}/${model.id}`),
        message.cost
      );
      if (step) this._costSteps.set(message.id, { ...step, cost: message.cost });
    }
    this._postCostSplit();
  }

  async _resolvePrices() {
    if (this._costPrices && Date.now() - this._costPricesAt < 60000) {
      return this._costPrices;
    }
    const prices = new Map();
    try {
      const models = await this.deps.api.listModels(this.cwd);
      for (const record of Array.isArray(models) ? models : []) {
        const entry = modelPrices(record);
        if (entry) prices.set(`${record.providerID}/${record.id}`, entry);
      }
    } catch (error) {
      this.deps.log(`Failed to resolve model prices: ${error.message}`);
    }
    this._costPrices = prices;
    this._costPricesAt = Date.now();
    return prices;
  }

  _postCostSplit() {
    if (this._disposed || this._costSteps.size === 0) return;
    const summary = summarizeCost([...this._costSteps.values()], this._sessionCost);
    const labels = {
      input: 'input',
      output: 'output (incl. reasoning)',
      cacheRead: 'cache read',
      cacheWrite: 'cache write',
    };
    const message = {
      type: 'costSplit',
      total: summary.total,
      rows: summary.rows
        .filter((row) => row.tokens > 0)
        .map((row) => ({
          key: row.key,
          label: labels[row.key],
          tokens: row.tokens,
          cost: row.cost,
        })),
    };
    const signature = JSON.stringify(message);
    if (signature === this._costSplitPosted) return;
    this._costSplitPosted = signature;
    this._post(message);
  }

  /**
   * ACP does not replay `usage_update` for loaded sessions, so estimate the
   * current context from the last assistant message before the first turn.
   */
  async _refreshUsageFromHistory() {
    if (this._disposed || !this.sessionId) return;
    try {
      const recent = await this.deps.api.listMessages(this.sessionId, {
        limit: 20,
        order: 'desc',
      });
      const candidates = recent
        .filter((message) => message && message.type === 'assistant' && message.id)
        .slice(0, 5);
      for (const candidate of candidates) {
        const message = await this.deps.api.getMessage(this.sessionId, candidate.id);
        if (this._disposed) return;
        if (!message) continue;
        const used = usageTotal(message.tokens);
        if (!used) continue;
        await this._postRestoredUsage(message, used);
        return;
      }
    } catch (error) {
      this.deps.log(`Failed to restore usage: ${error.message}`);
    }
  }

  async _postRestoredUsage(message, used) {
    const update = { sessionUpdate: 'usage_update', used };
    const model = (message && message.model) || this._modelRef;
    if (model) this._setModelRef(model);
    try {
      const info = await this.deps.api.getSession(this.sessionId);
      if (this._disposed) return;
      if (info && typeof info.cost === 'number') {
        this._sessionCost = info.cost;
        update.cost = { amount: info.cost, currency: 'USD' };
      }
    } catch (error) {
      this.deps.log(`Failed to restore session cost: ${error.message}`);
    }
    const size = await this._modelContextSize(model);
    if (this._disposed) return;
    if (size > 0) update.size = size;
    this._post({ type: 'update', update });
    this._postCacheStats(message);
    this._postCostSplit();
  }

  /**
   * Prompt composition of one completed step, for the session bar: how much of
   * the prompt came from the provider cache, and when it was measured. The
   * counters are exact — the server stores them per assistant message.
   */
  _postCacheStats(message) {
    const tokens = message && message.tokens;
    if (!tokens || typeof tokens !== 'object') return;
    const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
    const input = Number(tokens.input) || 0;
    const read = Number(cache.read) || 0;
    const write = Number(cache.write) || 0;
    const prompt = input + read + write;
    if (prompt <= 0) return;
    const time = message.time && typeof message.time === 'object' ? message.time : {};
    const at = Number(time.completed) || Number(time.created) || 0;
    this._post({ type: 'cacheStats', prompt, input, read, write, at });
  }

  /**
   * Step and token counters live in the webview DOM, so a reload rebuilds them
   * from the ACP replay, which carries no token metadata and fewer tool
   * updates. Replace them with estimates derived from the server history so a
   * restored turn looks like the turn that produced it.
   */
  async _restoreTurnStats() {
    if (this._disposed || !this.sessionId) return;
    try {
      const messages = await this.deps.api.listAllMessages(this.sessionId);
      if (this._disposed || messages.length === 0) return;
      const turns = buildTurnStats(messages);
      if (turns.length > 0) {
        this._post({ type: 'turnStats', turns, scope: 'all' });
      }
      await this._accountCosts(messages);
    } catch (error) {
      this.deps.log(`Failed to restore turn stats: ${error.message}`);
    }
  }

  /**
   * Cheap variant used after a turn ends: refresh only the newest block.
   */
  async _refreshLastTurnStats() {
    if (this._disposed || !this.sessionId) return;
    try {
      const recent = await this.deps.api.listMessages(this.sessionId, {
        limit: 100,
        order: 'desc',
      });
      if (this._disposed || recent.length === 0) return;
      const turns = buildTurnStats(recent.slice().reverse());
      const last = turns[turns.length - 1];
      if (last) this._post({ type: 'turnStats', turns: [last], scope: 'last' });
      const latest = recent.find(
        (item) => item && item.type === 'assistant' && item.tokens
      );
      this._postCacheStats(latest);
      await this._accountCosts(recent);
    } catch (error) {
      this.deps.log(`Failed to refresh turn stats: ${error.message}`);
    }
  }

  async _modelContextSize(model) {
    if (!model || !model.id) return 0;
    if (
      this._modelLimit &&
      this._modelLimit.context > 0 &&
      this._modelRef &&
      this._modelRef.id === model.id &&
      this._modelRef.providerID === model.providerID
    ) {
      return this._modelLimit.context;
    }
    try {
      const models = await this.deps.api.listModels(this.cwd);
      const record = matchModel(models, model);
      const limit = record && record.limit && record.limit.context;
      return typeof limit === 'number' && limit > 0 ? limit : 0;
    } catch (error) {
      this.deps.log(`Failed to resolve model limits: ${error.message}`);
      return 0;
    }
  }

  _startLimitsTimer() {
    if (this._limitsTimer || this._disposed) return;
    this._limitsTimer = setInterval(() => {
      this._refreshLimits();
      this._refreshCompaction();
      this._refreshBalance();
    }, 60000);
    if (this._limitsTimer.unref) this._limitsTimer.unref();
  }

  /**
   * Poll the child sessions of this session and post a compact summary to the
   * webview: how many are running, what each is doing, and an estimated token
   * count. Only direct children are shown; deeper nesting stays in the tree.
   */
  _startSubagentsPolling() {
    if (this._subagentsTimer || this._disposed) return;
    this._refreshSubagents();
    this._subagentsTimer = setInterval(() => this._refreshSubagents(), 3000);
    if (this._subagentsTimer.unref) this._subagentsTimer.unref();
  }

  async _refreshSubagents() {
    if (this._disposed || !this.sessionId || !this.cwd) return;
    if (this._subagentsRefreshing) return;
    this._subagentsRefreshing = true;
    try {
      const children = await this.deps.api.listSubagents(
        this.cwd,
        this.sessionId
      );
      if (this._disposed || !Array.isArray(children)) return;
      const polled = new Map();
      for (const child of children) {
        const updated =
          child.time && child.time.updated ? child.time.updated : 0;
        const cached = this._subagentsCache.get(child.id);
        let stats;
        if (cached && cached.updated === updated) {
          stats = cached.stats;
        } else {
          stats = await this._subagentStats(child.id);
          this._subagentsCache.set(child.id, { updated, stats });
        }
        const exactTokens = usageTotal(child.tokens);
        polled.set(child.id, {
          id: child.id,
          title: child.title || child.agent || 'Sub-agent',
          running: isRunning(child),
          action: stats.action,
          tokens: exactTokens || stats.tokens,
          exact: exactTokens > 0,
          cost: Number(child.cost) || 0,
        });
      }
      const ids = new Set(polled.keys());
      for (const key of this._subagentsCache.keys()) {
        if (!ids.has(key)) this._subagentsCache.delete(key);
      }
      this._subagentsPolled = polled;
      this._publishSubagents();
    } catch (error) {
      this.deps.log(`Failed to refresh sub-agents: ${error.message}`);
    } finally {
      this._subagentsRefreshing = false;
    }
  }

  /**
   * A fresh webview starts without a strip: forget the last signature so the
   * current sub-agent state is posted again.
   */
  _resendSubagents() {
    this._subagentsSignature = '';
    this._publishSubagents();
  }

  /**
   * Drop live sub-agent entries the REST list no longer reports, once they have
   * been quiet long enough for the poller to have caught up.
   */
  _pruneLiveSubagents(ids) {
    const now = Date.now();
    for (const [id, live] of this._subagentsLive) {
      if (!ids.has(id) && now - (live.seen || 0) > SUBAGENT_LIVE_TTL_MS) {
        this._subagentsLive.delete(id);
      }
    }
  }

  /**
   * Merge the polled sub-agent list with the live child-session updates pushed
   * over ACP and post the result to the webview strip.
   */
  _publishSubagents() {
    if (this._disposed) return;
    this._pruneLiveSubagents(new Set(this._subagentsPolled.keys()));
    const now = Date.now();
    const merged = new Map();
    for (const [id, item] of this._subagentsPolled) merged.set(id, { ...item });
    for (const [id, live] of this._subagentsLive) {
      const base = merged.get(id);
      const active = live.running === true && now - (live.seen || 0) < SUBAGENT_LIVE_BUSY_MS;
      const running = active || (base ? base.running : false);
      if (base) {
        merged.set(id, {
          ...base,
          title: live.title || base.title,
          action: live.action || base.action,
          running,
        });
      } else {
        merged.set(id, {
          id,
          title: live.title || 'Sub-agent',
          action: live.action || '',
          running,
          tokens: 0,
          exact: false,
          cost: 0,
        });
      }
    }
    const items = Array.from(merged.values());
    let totalCost = 0;
    for (const item of items) totalCost += Number(item.cost) || 0;
    const signature = JSON.stringify([
      items.map((item) => [
        item.id,
        item.title,
        item.running,
        item.action,
        item.tokens,
        item.exact === true,
        item.cost,
      ]),
      Math.round(totalCost * 1e6),
    ]);
    if (signature === this._subagentsSignature) return;
    this._subagentsSignature = signature;
    this._post({ type: 'subagents', items, totalCost });
  }

  /**
   * A child session pushed one of its own updates over ACP. Only direct
   * children feed the strip: the transcript stays untouched, so sub-agent
   * output can never split the parent's text into fragments.
   */
  _onChildUpdate(params) {
    if (this._disposed || !params || !this.sessionId) return;
    if (params.type && params.type !== 'update') return;
    if (params.rootSessionId && params.rootSessionId !== this.sessionId) return;
    if (params.parentSessionId && params.parentSessionId !== this.sessionId) {
      return;
    }
    const childId = params.childSessionId;
    const update = params.update;
    if (!childId || !update || typeof update !== 'object') return;
    if (childId === this.sessionId) return;
    const live = this._subagentsLive.get(childId) || {
      title: '',
      action: '',
      running: null,
      seen: 0,
    };
    if (typeof params.title === 'string' && params.title) {
      live.title = params.title;
    }
    live.seen = Date.now();
    const action = childUpdateAction(update);
    if (action) {
      live.action = action;
      live.running = true;
    }
    this._subagentsLive.set(childId, live);
    this._publishSubagents();
  }

  /**
   * Estimate a sub-agent's current action (last tool used) and token usage from
   * its recent message history, using the same heuristic as the restored turn
   * stats. `listMessages` returns message summaries with `content`, so this
   * needs no per-message detail calls.
   */
  async _subagentStats(childId) {
    try {
      const recent = await this.deps.api.listMessages(childId, {
        limit: 20,
        order: 'desc',
      });
      const messages = (Array.isArray(recent) ? recent : []).slice().reverse();
      let action = '';
      let tokens = 0;
      for (const message of messages) {
        if (!message || message.type !== 'assistant') continue;
        const parts = Array.isArray(message.content) ? message.content : [];
        let lastTool = '';
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          tokens += estimatePartTokens(part);
          if (part.type === 'tool') lastTool = part.name || 'tool';
        }
        if (lastTool) action = lastTool;
      }
      return { action: subagentAction(action), tokens };
    } catch (error) {
      this.deps.log(`Failed to load sub-agent stats for ${childId}: ${error.message}`);
      return { action: '', tokens: 0 };
    }
  }

  _refreshMetadata(delay) {
    if (!this.sessionId) return;
    this._trackTimeout(async () => {
      const id = this.sessionId;
      if (!id || this._disposed) return;
      try {
        const info = await this.deps.api.getSession(id);
        if (!info || this._disposed) return;
        if (info.title) {
          this._sessionTitle = info.title;
          if (info.title !== this.panel.title) {
            this.panel.title = info.title;
            this._post({ type: 'sessionInfo', title: info.title });
          }
        }
        if (info.model) this._setModelRef(info.model);
        this.deps.onSessionChanged();
      } catch (error) {
        this.deps.log(`Failed to refresh session ${id}: ${error.message}`);
      }
    }, delay);
  }

  _onExit(info) {
    if (this._disposed) return;
    this._busy = false;
    this._setIcon('idle');
    this._post({ type: 'status', state: 'error' });
    const detail = info && info.error
      ? info.error.message
      : `code=${info && info.code}, signal=${(info && info.signal) || 'none'}`;
    this._post({
      type: 'error',
      message: `OpenCode ACP process exited (${detail}). Close and reopen the tab.`,
    });
  }

  dispose() {
    if (!this._cleanedUp) {
      try {
        this.panel.dispose();
      } catch {
        // The panel may already be disposed by VS Code.
      }
    }
    this._cleanup();
  }

  _cleanup() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    this._disposed = true;

    for (const request of this._permissions.values()) {
      try {
        request.respond(null);
      } catch {
        // Ignore.
      }
    }
    this._permissions.clear();

    for (const request of this._elicitations.values()) {
      try {
        request.respond('cancel');
      } catch {
        // Ignore.
      }
    }
    this._elicitations.clear();

    for (const timer of this._metadataTimers) clearTimeout(timer);
    this._metadataTimers = [];

    if (this._limitsTimer) {
      clearInterval(this._limitsTimer);
      this._limitsTimer = null;
    }

    if (this._subagentsTimer) {
      clearInterval(this._subagentsTimer);
      this._subagentsTimer = null;
    }

    if (this._client) {
      this._client.dispose();
      this._client = null;
    }
    for (const disposable of this._disposables) {
      try {
        disposable.dispose();
      } catch {
        // Ignore.
      }
    }
    this.deps.onSessionDisposed(this);
  }
}

module.exports = { SessionPanel };

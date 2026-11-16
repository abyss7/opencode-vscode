'use strict';

/**
 * @file Session tab controller (`SessionPanel`).
 *
 * Coordinates the VS Code webview tab lifecycle, tab status icons, `SessionClient`
 * connection, prompt/command submission, and automatic editor-crash continuation.
 *
 * Domain-specific concerns are cleanly separated into `src/panel/`:
 * - `src/panel/html.js`              — CSP & webview HTML shell construction
 * - `src/panel/billing.js`           — Model context, limits, balance, cost split & turn stats
 * - `src/panel/permissions.js`       — Permission cards, saved rules, Smart reviews & elicitations
 * - `src/panel/subagents.js`         — Sub-agent strip polling & live ACP child updates
 * - `src/panel/workspace-actions.js` — Editor file/diff/link opening & slash discovery
 */

const vscode = require('vscode');
const { sessionActivity, UNCONFIRMED_MESSAGE } = require('./session-activity');
const { CONTINUE_TEXT } = require('./session-continuation');
const { SessionClient, toolUpdate } = require('./session-client');
const { normalizeAgentOptions } = require('./agent-label');
const { withClientContext, visiblePrompt } = require('./client-context');
const { buildHtml } = require('./panel/html');
const { panelBilling } = require('./panel/billing');
const { panelPermissions } = require('./panel/permissions');
const { panelSubagents } = require('./panel/subagents');
const { panelWorkspaceActions } = require('./panel/workspace-actions');

const ICON_FILES = {
  attention: 'opencode-attention.svg',
  working: 'opencode-working.svg',
  queued: 'opencode-queued.svg',
  done: 'opencode-done.svg',
  background: 'opencode-background.svg',
  loading: 'opencode-loading.svg',
  archived: 'opencode-archived.svg',
};

class SessionPanel {
  constructor(options) {
    this.panel = options.panel;
    this.deps = options.deps;
    this.sessionId = options.sessionId || null;
    this.newSessionId = options.newSessionId;
    this.cwd = options.cwd;
    this._archived = Boolean(options.archived);
    this._archiveFinalizing = Boolean(options.archiveFinalizing);
    this._loading = true;
    this._initialAgent = !this.sessionId && this.deps.defaultAgent
      ? this.deps.defaultAgent(this.cwd) : null;
    this._permissionState = null;
    this._permissionUpdating = false;

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
    const plans = this.deps.planDocuments;
    this._plans = plans && typeof plans.ingest === 'function' && typeof plans.pendingUpdates === 'function' ? plans : null;
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
    this.panel.title = this.sessionId ? 'OpenCode' : 'New Session';

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

  get awaitingWebview() {
    return !this._disposed && !this._started && !this._client;
  }

  get deleteIfEmptyOnClose() {
    return Boolean(this._disposed && this.newSessionId && !this._preserveSession && !this._promptSubmitted);
  }

  reveal() {
    if (this._disposed) return;
    this.panel.reveal();
    this._focusIfActive();
  }

  _setIcon(kind) {
    this._baseIconKind = kind;
    if (this._permissions.size || this._elicitations.size) kind = 'attention';
    else if (this._loading) kind = 'loading';
    else if (this._archiveFinalizing) kind = 'working';
    else if (this._archived) kind = 'archived';
    else if (kind === 'idle' && this._backgroundRunning) kind = 'background';
    if (this._disposed || this._iconKind === kind) return;
    this._iconKind = kind;
    const iconFile = ICON_FILES[kind];
    this.panel.iconPath = iconFile
      ? this._iconUri(iconFile)
      : { light: this._iconUri('opencode-light.svg'), dark: this._iconUri('opencode-dark.svg') };
  }

  _iconUri(file) {
    return vscode.Uri.joinPath(this.deps.extensionUri, 'media', file);
  }

  _refreshAttention() {
    this._setIcon(this._baseIconKind || 'idle');
  }

  _onViewState(event) {
    if (this._disposed) return;
    const panel = (event && event.webviewPanel) || this.panel;
    if (!panel || !panel.active) return;
    if (this._baseIconKind === 'done') this._setIcon('idle');
    this._focusIfActive();
  }

  _focusIfActive() {
    if (this._disposed || this.panel.active === false) return;
    this._post({ type: 'focus', preserveScroll: true });
    // The webview may still be hidden while the panel is being revealed, so ask
    // again once it has been laid out.
    this._trackTimeout(() => {
      if (!this._disposed && this.panel.active !== false) {
        this._post({ type: 'focus', preserveScroll: true });
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

  _startTurn(external = false) {
    this._turnRevision = (this._turnRevision || 0) + 1;
    this._externalTurn = external;
    this._busy = true;
    this._serverActivity = 'running';
    if (!external && !this._client?.shared) this.deps.api?.setSessionRunning?.(this.sessionId, this, true);
    this._setIcon('working');
    this._post({ type: 'status', state: 'busy', ...(external ? {
      external: true,
      message: 'Server reports active execution — live progress is unavailable in this tab.',
    } : {}) });
    this._refreshSubagents();
    this.deps.onSessionChanged?.();
  }

  _finishTurn(state) {
    if (state === 'ready') this._completeContinuation();
    this._turnRevision = (this._turnRevision || 0) + 1;
    this._externalTurn = false;
    this._busy = false;
    this.deps.api?.setSessionRunning?.(this.sessionId, this, false);
    this._serverActivity = state === 'unconfirmed' ? 'unconfirmed' : 'idle';
    const done = state === 'ready' && this.panel.active !== true;
    this._setIcon(done ? 'done' : 'idle');
    this._post({ type: 'status', state,
      ...(state === 'unconfirmed' ? { message: UNCONFIRMED_MESSAGE } : {}) });
  }

  _post(message) {
    if (this._disposed) return;
    if (message.type === 'config' && Array.isArray(message.configOptions)) {
      const recentValues = this.deps.workspaceState?.get('opencode.recentModels', []) || [];
      message = { ...message, configOptions: normalizeAgentOptions(message.configOptions).map((option) =>
        option.category === 'model' || option.id === 'model' ? { ...option, recentValues } : option) };
    }
    this.panel.webview.postMessage(message).then(undefined, (error) => {
      this.deps.log(`Webview postMessage failed: ${error.message}`);
    });
  }

  _onMessage(message) {
    if (this._disposed || !message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        this._post({ type: 'sessionInfo', title: this._sessionTitle, archived: this._archived });
        this._resendSubagents();
        // Metadata may have resolved before this webview was listening. The
        // unchanged model selection will not trigger another limits update.
        this._refreshModelContext();
        if (this._started && this._client?.shared) {
          this._post({ type: 'session', sessionId: this.sessionId, cwd: this.cwd, loaded: true });
          this._post({ type: 'config', configOptions: this._client.configOptions });
          this._client.replay().then(() => this._post({ type: 'historyEnd' }))
            .catch((error) => this._post({ type: 'error', message: error.message }));
          this._refreshLimits();
          this._refreshCompaction();
          this._refreshUsageFromHistory();
          this._refreshBalance(true);
        } else this._start();
        break;
      case 'prompt':
        this._prompt(
          String(message.text || ''),
          Array.isArray(message.images) ? message.images : [],
          message.selection || null,
          null,
          message.id
        );
        break;
      case 'resend': {
        const item = message.item;
        if (!item || typeof item.id !== 'string' || !item.payload || typeof item.payload !== 'object') break;
        return this._prompt(String(item.payload.text || ''), [], item.selection || null, null, item.id, item.payload);
      }
      case 'command':
        this._runCommand(String(message.name || ''), String(message.text || ''));
        break;
      case 'openSession':
        return this._openSession(String(message.sessionId || ''));
      case 'cancel':
        this._cancel();
        break;
      case 'stopBackground':
        if (typeof message.toolCallId === 'string') this._client?.stopBackground(message.toolCallId);
        break;
      case 'permissionResponse':
        this._answerPermission(message.requestId, message.optionId || null);
        break;
      case 'savePermissionRule':
        this._rememberPermission(message);
        break;
      case 'openPermissionRules':
        this._openPermissionRules();
        break;
      case 'elicitationResponse':
        this._answerElicitation(
          message.requestId,
          message.action === 'accept' || message.action === 'decline' ? message.action : 'cancel',
          message.content || null
        );
        break;
      case 'setConfigOption':
        this._setConfigOption(String(message.configId || ''), String(message.value || ''));
        break;
      case 'setPermissionProfile':
        this._changePermissions(message);
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
      case 'openDiff':
        this._openDiff(message);
        break;
      case 'exportArtifact':
        this._exportArtifact(message);
        break;
      case 'planArtifact':
        if (typeof message.source === 'string') this._plans?.ingest(this.sessionId, message.source);
        break;
      case 'openPlan':
        this._plans?.reveal(this.sessionId, String(message.id || ''));
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
    const client = new SessionClient({
      api: this.deps.api,
      cwd: this.cwd,
      log: this.deps.log,
    });
    this._client = client;

    client.on('transcript', (snapshot) => this._post({ type: 'transcript', ...snapshot,
      messages: snapshot.messages.map((message) => message.type !== 'assistant' ? message : {
        ...message, content: message.content.map((part) => part.type === 'tool'
          ? { ...part, update: toolUpdate(part) } : part),
      }),
    }));
    client.on('submission', (submission) => this._post({ type: 'submission', ...submission }));
    client.on('thoughtCaption', (summary) => this._post({ type: 'thoughtCaption', summary }));
    client.on('activity', (activity) => this._onServerActivity(activity));
    client.on('background', (runs) => {
      const running = runs.some((run) => run.status === 'running' || run.status === 'stopping');
      const changed = this._backgroundRunning !== running;
      this._backgroundRunning = running;
      this._refreshAttention();
      this._post({ type: 'background', runs });
      if (changed) this.deps.onSessionChanged?.();
    });
    client.on('backgroundStopError', (error) => this._post({ type: 'backgroundStopError', ...error }));
    client.on('commandProgress', (items) => this._post({ type: 'commandProgress', items }));
    client.on('connection', (connected) => {
      if (!connected) this._post({ type: 'status', state: 'connecting',
        message: 'Reconnecting — server work continues.' });
    });
    client.on('notice', (message) => this._post({ type: 'error', message }));
    client.on('childActivity', () => this._refreshSubagents());
    client.on('requestResolved', ({ kind, id }) => {
      (kind === 'permission' ? this._permissions : this._elicitations).delete(id);
      this._post({ type: 'requestResolved', kind, requestId: id });
      this._refreshAttention();
    });

    client.on('update', (params) => this._onAcpUpdate(params));
    client.on('childUpdate', (params) => this._onChildUpdate(params));
    client.on('permission', (request) => this._onPermission(request));
    client.on('elicitation', (request) => this._onElicitation(request));
    client.on('title', (title) => this._onTitle(title));
    client.on('configOptions', (options) => {
      this._post({ type: 'config', configOptions: options });
      this._syncModelOptions(options);
    });
    client.on('capabilities', (images) => {
      this._post({ type: 'capabilities', transport: 'server', images: Boolean(images) });
    });
    client.on('exit', (info) => this._onExit(info));

    try {
      if (this.deps.permissions) await this.deps.permissions.ready(this.cwd);
      if (this.deps.archive) await this.deps.archive.ready(this.cwd);
      await client.start();
      if (this._disposed) return;
      this._post({
        type: 'capabilities',
        transport: 'server',
        images: client.imageSupport !== false,
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
        const result = await client.newSession(this._initialAgent, this.newSessionId);
        this.sessionId = result.sessionId;
        if (this._disposed) {
          await this.deps.onSessionCreated(this, result.sessionId, this.cwd);
          return;
        }
        this.panel.title = 'New Session';
        this._post({
          type: 'session',
          sessionId: this.sessionId,
          cwd: this.cwd,
          loaded: false,
        });
        await this.deps.onSessionCreated(this, this.sessionId, this.cwd);
      }

      if (this.deps.permissions) await this._refreshPermissionProfile();
      this._post({ type: 'config', configOptions: client.configOptions || [] });
      this._syncModelOptions(client.configOptions || []);
      this._post({ type: 'historyEnd' });
      this._loadSlashItems();
      this._trackTimeout(() => this._loadSlashItems(), 3000);
      await this._refreshServerStatus();
      if (this._disposed) return;
      this._loading = false;
      this._refreshAttention();
      if (!this._busy && this._serverActivity !== 'unconfirmed') this._post({ type: 'status', state: 'ready' });
      this._focusIfActive();
      this._refreshLimits();
      this._refreshCompaction();
      this._refreshUsageFromHistory();
      this._refreshBalance(true);
      this._restoreTurnStats();
      this._startLimitsTimer();
      this._startSubagentsPolling();
    } catch (error) {
      if (!this.sessionId && client.sessionId) {
        this.sessionId = client.sessionId;
        await this.deps.onSessionCreated(this, this.sessionId, this.cwd);
      }
      this._started = false;
      client.dispose();
      this.deps.log(`Session connection failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'status', state: 'error' });
      this._post({ type: 'error', message: this._friendlyError(error, config.command) });
      if (this.sessionId) this._trackTimeout(() => this._start(), 5000);
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
    if (this.sessionId && incoming && incoming !== this.sessionId) return;
    if (this.sessionId && !incoming && !this._missingSessionIdLogged) {
      this._missingSessionIdLogged = true;
      this.deps.log('ACP session/update without sessionId; rendering it in the current tab');
    }
    this._post({ type: 'update', update: params.update || {} });
  }

  applyTitle(title) {
    if (this._disposed || !title) return;
    if (this._sessionTitle === title && this.panel.title === title) return;
    this._sessionTitle = title;
    this.panel.title = title;
    this._post({ type: 'sessionInfo', title, archived: this._archived });
    this._plans?.setSessionTitle(this.sessionId, title);
    this.deps.onSessionTitle?.(this.sessionId || this.newSessionId, title);
  }

  setArchived(archived) {
    const value = Boolean(archived);
    if (this._archived === value) return;
    this._archived = value;
    if (value) {
      for (const [id, request] of this._elicitations) {
        this._elicitations.delete(id);
        this._post({ type: 'requestResolved', kind: 'elicitation', requestId: id });
        request.respond('decline');
      }
    }
    if (!value) this._archiveFinalizing = false;
    this._refreshAttention();
    this._post({ type: 'sessionInfo', title: this._sessionTitle, archived: value });
  }

  setArchiveFinalizing(finalizing) {
    const value = Boolean(finalizing);
    if (this._archiveFinalizing === value) return;
    this._archiveFinalizing = value;
    this._refreshAttention();
  }

  _onTitle(title) {
    if (this._disposed || !title) return;
    this.applyTitle(title);
    this.deps.onSessionChanged();
  }

  async _prompt(text, images, selection, continuation = null, id = undefined, resubmission = null) {
    if (this._archived || this._disposed) return;
    const value = text.trim();
    const blocks = [];
    if (value) blocks.push({ type: 'text', text: value });
    for (const image of Array.isArray(images) ? images : []) {
      if (!image || typeof image.data !== 'string' || !image.data) continue;
      if (typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/')) continue;
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
    if ((!blocks.length && !resubmission?.files?.length) || !this._client || !this.sessionId) {
      if (resubmission && id) this._post({ type: 'submission', id, state: 'failed' });
      return;
    }
    // Protect admission in flight: the server may not have a message yet.
    this._promptSubmitted = true;
    if (this.deps.permissions && !(await this._permissionsBeforePrompt())) {
      if (id) this._post({ type: 'submission', id, state: 'failed', error: 'Permission settings could not be applied.' });
      return;
    }
    if (this._disposed) return;

    if (continuation && this._busy) return;
    try {
      this._continuation = continuation || this._continuation ||
        this.deps.continuations?.begin(this.sessionId, process.pid);
    } catch (error) {
      this.deps.log(`Cannot save continuation state: ${error.message}`);
    }

    // Server inbox payloads already include the original client/selection
    // context. Locally failed submissions still need it attached once.
    const planUpdates = !resubmission && this._plans ? this._plans.pendingUpdates(this.sessionId) : null;
    const promptText = resubmission && visiblePrompt(value) !== value ? value : withClientContext(value, selection, planUpdates);
    const textBlock = blocks.find((block) => block.type === 'text');
    if (textBlock) textBlock.text = promptText;
    else blocks.unshift({ type: 'text', text: promptText });

    try {
      if (resubmission) await this._client.resend(id, { ...resubmission, text: promptText });
      else await this._client.prompt(blocks, { id, synthetic: Boolean(continuation) });
    } catch (error) {
      this.deps.log(`Prompt failed: ${error.stack || error.message}`);
      this._post({ type: 'error', message: error.message || String(error) });
    }
  }

  _onServerActivity(activity) {
    if (this._disposed) return;
    const previous = this._serverActivity;
    this._serverActivity = activity;
    if (activity === 'running') {
      this._busy = true;
      this._setIcon('working');
      this._post({ type: 'status', state: 'busy' });
    } else {
      const finished = this._busy;
      if (finished && (activity === 'idle' || activity === 'queued')) {
        this._post({ type: 'turnEnd', stopReason: 'end_turn' });
      }
      if (finished) {
        this._finishTurn(activity === 'unconfirmed' ? 'unconfirmed' : 'ready');
        this._afterTurn();
      }
      this._serverActivity = activity;
      if (activity === 'queued') {
        this._setIcon('queued');
        this._post({ type: 'status', state: 'queued' });
      } else if (!finished) {
        // An unchanged idle snapshot must not clear an unread completion icon.
        if (previous === 'queued' || previous === 'unconfirmed') this._setIcon('idle');
        this._post({ type: 'status', state: activity === 'unconfirmed' ? 'unconfirmed' : 'ready',
          ...(activity === 'unconfirmed' ? { message: UNCONFIRMED_MESSAGE } : {}) });
      }
    }
    if (previous !== activity) this.deps.onSessionChanged?.();
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
    this._refreshSmartReviews();
  }

  async _runCommand(name, text) {
    const command = name.replace(/^\/+/, '').trim();
    const archive = command === 'archive';
    if (!command || !this.sessionId || !this._client || this._archived || (this._busy && !archive)) return;
    if (!archive && this.deps.permissions && !(await this._permissionsBeforePrompt())) return;

    try {
      if (command === 'compact') {
        await this.deps.api.compactSession(this.sessionId);
      } else if (archive && this.deps.archiveSession) {
        await this.deps.archiveSession(this.sessionId, this.cwd);
      } else {
        await this.deps.api.runCommand(this.sessionId, command, text,
          archive ? { delivery: 'queue' } : undefined);
      }
      this._client.full = true;
      await this._client.reconcile();
      if (archive) this.deps.onSessionChanged();
    } catch (error) {
      this.deps.log(`Command /${command} failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'error', message: error.message || String(error) });
    }
  }

  async _reloadTranscript() {
    if (this._disposed || !this._client || !this.sessionId) return;
    this._client.full = true;
    await this._client.reconcile();
    this._post({ type: 'config', configOptions: this._client.configOptions || [] });
    this._syncModelOptions(this._client.configOptions || []);
    this._refreshUsageFromHistory();
    this._restoreTurnStats();
    this._refreshBalance();
  }

  _cancel() {
    if (!this._client || !this._busy) return;
    try { this.deps.continuations?.stop?.(this.sessionId); }
    catch (error) { this.deps.log(`Cannot record explicit Stop: ${error.message}`); }
    this._completeContinuation();
    this._post({ type: 'status', state: 'cancelling' });
    for (const request of this._elicitations.values()) {
      try { request.respond('cancel'); } catch { /* Ignore */ }
    }
    this._elicitations.clear();
    this._refreshAttention();
    if (this._externalTurn) {
      this.deps.api.interruptSession(this.sessionId).catch((error) => {
        if (this._disposed) return;
        this.deps.log(`Cannot stop server execution: ${error.message}`);
        this._post({ type: 'error', message: error.message });
        this._post({ type: 'status', state: 'busy', external: true,
          message: 'Server execution could not be stopped.' });
      });
      return;
    }
    this._client.cancel();
  }

  async _setConfigOption(configId, value) {
    if (!this._client || !configId || !value) return;
    const option = (this._client.configOptions || []).find((item) => item.id === configId);
    if (configId === 'mode' || configId === 'agent' || option?.category === 'mode') {
      this._post({ type: 'error', message: 'The agent is fixed when the session is created.' });
      this._post({ type: 'config', configOptions: this._client.configOptions || [] });
      return;
    }
    try {
      const options = await this._client.setConfigOption(configId, value);
      if (this._disposed) return;
      if ((configId === 'model' || option?.category === 'model') && this.deps.workspaceState) {
        const stored = this.deps.workspaceState.get('opencode.recentModels', []);
        const recent = [...new Set([value, option?.currentValue, ...(Array.isArray(stored) ? stored : [])])]
          .filter((item) => typeof item === 'string' && item).slice(0, 4);
        try {
          await this.deps.workspaceState.update('opencode.recentModels', recent);
          this.deps.onRecentModelsChanged?.(this);
        } catch (error) {
          this.deps.log(`Cannot store recent models: ${error.message}`);
        }
      }
      this._post({ type: 'config', configOptions: options || [] });
      this._syncModelOptions(options || []);
    } catch (error) {
      this.deps.log(`setConfigOption failed: ${error.stack || error.message}`);
      if (this._disposed) return;
      this._post({ type: 'error', message: error.message || String(error) });
      this._post({ type: 'config', configOptions: this._client.configOptions || [] });
    }
  }

  refreshRecentModels() {
    if (this._client) this._post({ type: 'config', configOptions: this._client.configOptions || [] });
  }

  async _refreshServerStatus() {
    if (this._client?.shared) {
      if (this._disposed || !this.sessionId || this._client.closed) return;
      try {
        await this._client.reconcile();
        if (this._resuming || this._busy || !this.deps.continuations) return;
        const info = await this.deps.api.getSession(this.sessionId);
        if (this._disposed || sessionActivity(info) === 'running') return;
        const continuation = this.deps.continuations.claim(info, process.pid);
        if (!continuation) return;
        this._resuming = true;
        try { await this._prompt(CONTINUE_TEXT, [], null, continuation); }
        finally { this._resuming = false; }
      } catch (error) { this.deps.log(`Server reconciliation failed: ${error.message}`); }
      return;
    }
    if (this._disposed || !this.sessionId || !this._client || this._client.closed ||
        this._serverStatusRefreshing || (this._busy && !this._externalTurn)) return;
    this._serverStatusRefreshing = true;
    const revision = this._turnRevision;
    try {
      const info = await this.deps.api.getSession(this.sessionId);
      // A local prompt may have started while the REST request was in flight.
      if (this._disposed || this._client.closed || revision !== this._turnRevision || !info) return;
      const activity = sessionActivity(info);
      if (!this._resuming && activity !== 'running' && this.deps.continuations) {
        const continuation = this.deps.continuations.claim(info, this._client.child?.pid);
        if (continuation) {
          this._resuming = true;
          this._post({ type: 'info', text: 'Continuing the work interrupted when the editor closed.' });
          this._prompt(CONTINUE_TEXT, [], null, continuation)
            .catch((error) => this.deps.log(`Automatic continuation failed: ${error.message}`))
            .finally(() => { this._resuming = false; });
          return;
        }
      }
      if (activity === 'running') {
        if (!this._busy) this._startTurn(true);
      } else if (this._externalTurn) {
        // ACP only streams prompts initiated by this client. Restore the final
        // transcript before announcing completion of an externally started turn.
        await this._reloadTranscript();
        if (this._disposed || this._client.closed || revision !== this._turnRevision) return;
        this._queuedCount = 0;
        this._finishTurn(activity === 'unconfirmed' ? 'unconfirmed' : 'ready');
        this._afterTurn();
      } else if (this._serverActivity !== activity) {
        if (activity === 'unconfirmed' || this._serverActivity === 'unconfirmed') {
          this._finishTurn(activity === 'unconfirmed' ? 'unconfirmed' : 'ready');
        } else {
          // The initial idle snapshot is not a newly completed turn.
          this._serverActivity = activity;
        }
      }
    } catch (error) {
      this.deps.log(`Failed to refresh server session state: ${error.message}`);
    } finally {
      this._serverStatusRefreshing = false;
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
        if (info.title) this.applyTitle(info.title);
        if (info.model) this._setModelRef(info.model);
        this.deps.onSessionChanged();
      } catch (error) {
        this.deps.log(`Failed to refresh session ${id}: ${error.message}`);
      }
    }, delay);
  }

  _onExit(info) {
    if (this._disposed) return;
    this.deps.api?.setSessionRunning?.(this.sessionId, this, false);
    this._busy = false;
    this._permissions.clear();
    this._elicitations.clear();
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

  _completeContinuation() {
    try { this.deps.continuations?.complete(this._continuation); }
    catch (error) { this.deps.log(`Cannot clear continuation state: ${error.message}`); }
    this._continuation = null;
  }

  dispose() {
    // Explicit deletion and extension shutdown manage their own lifecycle.
    this._preserveSession = true;
    if (!this._cleanedUp) {
      try { this.panel.dispose(); } catch { /* Already disposed by VS Code */ }
    }
    this._cleanup();
  }

  _cleanup() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    this._disposed = true;
    this.deps.api?.setSessionRunning?.(this.sessionId, this, false);
    this._plans?.closeSession(this.sessionId);

    for (const request of this._client?.shared ? [] : this._permissions.values()) {
      try { request.respond(null); } catch { /* Ignore */ }
    }
    this._permissions.clear();

    for (const request of this._client?.shared ? [] : this._elicitations.values()) {
      try { request.respond('cancel'); } catch { /* Ignore */ }
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
      try { disposable.dispose(); } catch { /* Ignore */ }
    }
    this.deps.onSessionDisposed(this);
  }
}

Object.assign(
  SessionPanel.prototype,
  panelBilling,
  panelPermissions,
  panelSubagents,
  panelWorkspaceActions
);

module.exports = { SessionPanel };

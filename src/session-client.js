'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ServerEvents } = require('./server-events');
const { sessionActivity } = require('./session-activity');
const { nativeDiffs } = require('./native-diffs');
const { parseModelRef } = require('./usage');
const { modelRefString } = require('./model-ref');
const { backgroundRun, active: backgroundActive } = require('./background-runs');

const messageID = () => `msg_${randomUUID().replaceAll('-', '')}`;
const unwrap = (value) => value?.data ?? value;

function toolUpdate(part) {
  const state = part.state || {};
  const content = (state.content || []).flatMap((item) => {
    if (item.type === 'text') return [{ type: 'content', content: { type: 'text', text: item.text } }];
    if (item.type === 'file' && /^data:image\//.test(item.uri)) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.uri);
      if (match) return [{ type: 'content', content: { type: 'image', mimeType: match[1], data: match[2] } }];
    }
    if (item.type === 'file') return [{ type: 'content', content: {
      type: 'resource_link', uri: item.uri, mimeType: item.mime, name: item.name || 'File',
    } }];
    return [];
  });
  if (state.error) content.push({ type: 'content', content: {
    type: 'text', text: state.error.message || JSON.stringify(state.error),
  } });
  content.push(...(part.diffs || []));
  if (!part.diffs?.length) {
    for (const file of state.metadata?.files || []) {
      if (typeof file.patch === 'string') content.push({ type: 'content', content: { type: 'text', text: file.patch } });
    }
  }
  return { sessionUpdate: 'tool_call_update', toolCallId: part.id,
    title: state.metadata?.title || part.name, kind: toolKind(part.name),
    status: state.status === 'error' ? 'failed' : state.status === 'completed' ? 'completed' : 'in_progress',
    background: backgroundRun(part),
    rawInput: state.input, rawOutput: { metadata: state.metadata,
      ...(state.error ? { error: state.error.message || JSON.stringify(state.error) } : {}) }, content };
}

function toolKind(name) {
  if (/read|glob|grep/.test(name)) return 'read';
  if (/edit|patch|write/.test(name)) return 'edit';
  if (/shell|bash/.test(name)) return 'execute';
  if (/fetch|search/.test(name)) return 'fetch';
  return 'other';
}

function choiceOptions(options) {
  return (options || []).map((option) => ({
    const: option.value, title: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
}

function stringLimits(field) {
  const limits = {};
  if (field.format !== undefined) limits.format = field.format;
  if (field.minLength !== undefined) limits.minLength = field.minLength;
  if (field.maxLength !== undefined) limits.maxLength = field.maxLength;
  if (field.pattern !== undefined) limits.pattern = field.pattern;
  return limits;
}

// Mirror OpenCode's ACP elicitation schema: a native form select becomes a
// oneOf/anyOf list, and `custom` adds the "type your own answer" input that the
// question tool needs. Hidden and conditional fields cannot be represented.
function formSchema(fields) {
  const properties = {};
  const required = [];
  for (const field of fields || []) {
    if (field.type === 'external' || field.hidden) continue;
    const { key, options, hidden, when, custom, required: isRequired, ...schema } = field;
    const choices = options?.length ? options : null;
    if (field.type === 'multiselect') {
      schema.type = 'array';
      if (choices) schema.items = { anyOf: choiceOptions(choices) };
      if (isRequired) schema.minItems = Math.max(field.minItems ?? 0, 1);
    } else if (field.type === 'string' && choices) {
      schema.oneOf = choiceOptions(choices);
    }
    properties[key] = schema;
    if (isRequired) required.push(key);
    // A required choice cannot be satisfied by a free-form answer alone.
    if (custom && choices && !isRequired && (field.type === 'string' ||
        field.type === 'multiselect' && field.minItems === undefined && field.maxItems === undefined)) {
      properties[`${key}_custom`] = { type: 'string', title: 'Custom answer',
        ...(field.type === 'string' ? stringLimits(field) : {}) };
    }
  }
  return { type: 'object', properties, required };
}

// The schema sends free-form answers under `<key>_custom`; the server reads
// them from the field itself. Hidden fields keep their defaults.
function formAnswer(fields, content) {
  const answer = { ...(content || {}) };
  for (const field of fields || []) {
    if (field.type === 'external') continue;
    if (field.hidden) {
      if (field.default === undefined) delete answer[field.key];
      else answer[field.key] = field.default;
      continue;
    }
    const key = `${field.key}_custom`;
    if (!(key in answer)) continue;
    const custom = answer[key];
    delete answer[key];
    if (typeof custom !== 'string' || custom.trim() === '') continue;
    if (field.type === 'string') answer[field.key] = custom;
    else if (field.type === 'multiselect') {
      answer[field.key] = [...(Array.isArray(answer[field.key]) ? answer[field.key] : []), custom];
    }
  }
  return answer;
}

// One server owns prompts, queued work, tools, permissions and cancellation.
// Events invalidate snapshots; deltas are deliberately not appended on top of
// snapshots, which avoids duplicate text at the reconnect/snapshot boundary.
class SessionClient extends EventEmitter {
  constructor({ api, cwd, log = () => {} }) {
    super();
    this.api = api;
    this.cwd = cwd;
    this.log = log;
    this.closed = false;
    this.shared = true;
    this.configOptions = [];
    this.capabilities = { promptCapabilities: { image: true } };
    this.messages = new Map();
    this.emitted = new Map();
    this.liveText = new Map();
    this.liveTools = new Map();
    this.diffs = new Map();
    this.permissions = new Map();
    this.forms = new Map();
    this.ancestry = new Map();
    this.submissions = new Map();
    this.connected = false;
    this.full = true;
    this.revision = 0;
  }

  async request(method, suffix, body, sessionId = this.sessionId) {
    return unwrap(await this.api._request(method,
      `/api/session/${encodeURIComponent(sessionId)}${suffix}`, body));
  }

  async belongsToSession(id, seen = new Set()) {
    if (id === this.sessionId) return true;
    if (!id || seen.has(id)) return false;
    if (this.ancestry.has(id)) return this.ancestry.get(id);
    seen.add(id);
    const session = await this.api.getSession(id);
    const owned = Boolean(session?.parentID) && await this.belongsToSession(session.parentID, seen);
    this.ancestry.set(id, owned);
    return owned;
  }

  async pendingRequests(kind) {
    const query = new URLSearchParams({ 'location[directory]': this.cwd });
    const items = unwrap(await this.api._request('GET', `/api/${kind}?${query}`));
    const relevant = await Promise.all((items || []).map(async (item) =>
      await this.belongsToSession(item.sessionID) ? item : null));
    return relevant.filter(Boolean);
  }

  async start() {
    await this.api._resolveServer();
    this.stream = new ServerEvents(this.api, {
      connected: () => {
        this.connected = true;
        this.full = true;
        this.schedule();
      },
      disconnected: (error) => {
        this.connected = false;
        // Missing volatile deltas cannot be replayed. Keep the last rendered
        // prefix, then replace it with the authoritative *.ended text.
        this.liveText.clear();
        this.liveTools.clear();
        this.log(`Live connection lost: ${error.message}`);
        this.emit('connection', false);
      },
      event: (event) => this.onEvent(event),
    });
    this.stream.start();
  }

  async newSession(agent, id = `ses_${randomUUID().replaceAll('-', '')}`) {
    let info;
    try {
      const [documents, agents] = await Promise.all([
        this.api.getConfig(this.cwd), this.api.listAgents(this.cwd),
      ]);
      // The catalog's /model/default drops the configured #variant. Preserve
      // an explicit default on creation, rather than guessing a provider level
      // or changing existing sessions when settings are edited later.
      const configured = documents.reduce((model, entry) => entry.info?.model === undefined ? model
        : parseModelRef(modelRefString(entry.info.model)), null);
      const selectedAgent = agent ? agents.find((item) => item.id === agent)
        : agents.find((item) => !item.hidden && item.mode !== 'subagent');
      const model = selectedAgent?.model || configured;
      info = unwrap(await this.api._request('POST', '/api/session', {
        id, location: { directory: this.cwd }, ...(agent ? { agent } : {}),
        ...(model?.variant && model.variant !== 'default' ? { model } : {}),
      }));
    } catch (error) {
      // The request layer may retry a lost response; use the same ID and
      // recover the created session rather than creating a second one.
      try { info = await this.api.getSession(id); } catch { /* preserve admission error */ }
      if (!info) throw error;
    }
    await this.loadSession(info.id);
    return { sessionId: info.id };
  }

  async loadSession(id) {
    this.sessionId = id;
    this.full = true;
    await this.refreshConfig();
    await this.reconcile();
    return { configOptions: this.configOptions };
  }

  onEvent(event) {
    if (event.type === 'server.connected') return;
    if (event.type.startsWith('shell.')) {
      this.refreshBackground();
      return;
    }
    const data = event.data || {};
    const id = data.sessionID || data.form?.sessionID || data.request?.sessionID;
    if (id !== this.sessionId) {
      if (/^(permission|form)\./.test(event.type)) {
        this.belongsToSession(id).then((owned) => { if (owned) this.schedule(); })
          .catch((error) => this.log(`Cannot resolve request owner: ${error.message}`));
      }
      if (this.ancestry.get(id)) this.emit('childActivity', id);
      return;
    }
    const textEvent = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(event.type);
    if (textEvent) {
      const kind = textEvent[1] === 'text' ? 'text' : 'reasoning';
      const key = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
      const previous = this.liveText.get(key);
      if (textEvent[2] === 'started') this.liveText.set(key, {
        messageID: data.assistantMessageID, ordinal: data.ordinal,
        type: kind, text: '',
      });
      else if (textEvent[2] === 'ended') this.liveText.set(key, {
        messageID: data.assistantMessageID, ordinal: data.ordinal,
        type: kind, text: data.text, ended: true,
      });
      else if (previous && !previous.ended) previous.text += data.delta;
    }
    if (event.type === 'session.tool.progress') this.liveTools.set(data.id, data.metadata);
    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') this.liveTools.delete(data.id);
    if (!event.type.endsWith('.delta')) this.revision++;
    if (/session\.(execution|inbox|status)/.test(event.type)) this.api._activeRead = null;
    if (event.type === 'session.inbox.cancelled') {
      this.submissions.delete(data.inboxID);
      this.emit('submission', { id: data.inboxID, state: 'cancelled' });
    }
    if (event.type.startsWith('session.inbox.') || event.type.startsWith('session.execution.')) this.full = true;
    this.schedule();
  }

  schedule(delay = 150) {
    if (this.closed || !this.sessionId || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconcile().catch((error) => {
        this.log(`Session reconciliation failed: ${error.message}`);
        this.emit('connection', false);
        this.full = true;
        this.schedule(1000);
      });
    }, delay);
    this.timer.unref?.();
  }

  async reconcile() {
    if (this.closed || !this.sessionId) return;
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = this.snapshot();
    try { await this.refreshing; }
    finally {
      this.refreshing = null;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }

  async snapshot() {
    const revision = this.revision;
    const full = this.full;
    this.full = false;
    // Tail reads handle token streaming cheaply. A fresh connection always
    // walks all pages: there may be arbitrarily many messages missed offline.
    const [history, inbox, info, permissions, forms] = await Promise.all([
      full ? this.api.listAllMessages(this.sessionId, { limit: Infinity }) :
        this.api.listMessages(this.sessionId, { limit: 200, order: 'desc' }).then((items) => items.reverse()),
      this.request('GET', '/inbox'), this.api.getSession(this.sessionId),
      this.pendingRequests('permission/request'), this.pendingRequests('form'),
    ]);
    if (this.closed) return;
    // An event arriving during the reads invalidates the composite snapshot.
    // Re-read rather than letting an old inbox overwrite a delivery event.
    const stale = revision !== this.revision;
    if (stale) { this.again = true; this.full ||= full; }
    const previous = this.messages;
    if (full) this.messages = new Map();
    for (const source of history) {
      let message = source;
      if (source.type === 'assistant') {
        const old = previous.get(source.id);
        const ordinals = { text: 0, reasoning: 0 };
        message = { ...source, content: source.content.map((part, index) => {
          const ordinal = ordinals[part.type]++;
          const live = this.liveText.get(`${source.id}:${part.type}:${ordinal}`);
          if (live && live.type === part.type && !source.time.completed) return { ...part, text: live.text };
          const prefix = old?.content[index];
          if (!source.time.completed && prefix?.type === part.type && typeof part.text === 'string' &&
              prefix.text?.startsWith(part.text)) return { ...part, text: prefix.text };
          if (part.type === 'tool' && this.liveTools.has(part.id) && part.state.status === 'running') {
            return { ...part, state: { ...part.state, metadata: this.liveTools.get(part.id) } };
          }
          return part;
        }) };
        if (source.time.completed) {
          for (const [key, part] of this.liveText) if (part.messageID === source.id) this.liveText.delete(key);
        }
        for (const part of message.content) {
          if (part.type !== 'tool' || part.state.status !== 'completed' || !Array.isArray(part.state.metadata?.files)) continue;
          if (!this.diffs.has(part.id)) this.diffs.set(part.id, await nativeDiffs(part.state.metadata, this.cwd));
          part.diffs = this.diffs.get(part.id);
        }
      }
      this.messages.set(message.id, message);
    }
    const messages = [...this.messages.values()];
    const pending = Array.isArray(inbox) ? [...inbox] : [];
    const states = new Map();
    let active = [];
    for (const message of messages) {
      if (message.type === 'user') { states.set(message.id, 'running'); active.push(message.id); }
      if (message.type === 'idle') {
        for (const id of active) states.set(id, message.outcome === 'succeeded' ? 'completed' : message.outcome);
        active = [];
      }
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      if (states.has(pending[index].id)) pending.splice(index, 1);
    }
    for (const item of pending) states.set(item.id, 'queued');
    for (const [id, submission] of this.submissions) {
      if (states.has(id) || this.messages.has(id)) this.submissions.delete(id);
      else if (['sending', 'queued', 'unknown'].includes(submission.state)) {
        pending.push({ ...submission.item, submissionState: submission.state });
      }
    }
    const changed = messages.filter((message) => {
      const value = JSON.stringify(message);
      if (this.emitted.get(message.id) === value) return false;
      this.emitted.set(message.id, value);
      return true;
    });
    if (stale || revision !== this.revision) {
      this.again = true;
      this.full ||= full;
      this.emit('transcript', { messages: changed, partial: true });
      return;
    }
    this.emit('transcript', { messages: changed, inbox: pending, states: [...states] });
    this.refreshBackground();
    await this.syncRequests(permissions || [], forms || []);
    if (this.closed) return;
    if (revision !== this.revision) { this.again = true; return; }
    if (info?.title) this.emit('title', info.title);
    const activity = sessionActivity(info);
    this.emit('activity', pending.length && activity === 'idle'
      ? pending.some((item) => item.submissionState === 'unknown') ? 'unconfirmed' : 'queued' : activity);
    this.emit('connection', this.connected);
  }

  /**
   * A pending permission names the tool call that raised it, but the arguments
   * live on that call, not in `permission.metadata`: shell, read and grep pass
   * no metadata at all, so the card would otherwise show no command or context.
   * Child sessions are not part of this transcript; read their message instead.
   */
  async permissionInput(permission) {
    const source = permission?.source;
    if (source?.type !== 'tool' || !source.id || !source.messageID) return null;
    const find = (message) => (Array.isArray(message?.content) ? message.content : [])
      .find((part) => part?.type === 'tool' && part.id === source.id)?.state?.input ?? null;
    const cached = find(this.messages.get(source.messageID));
    if (cached) return cached;
    try {
      return find(await this.api.getMessage(permission.sessionID, source.messageID));
    } catch {
      return null;
    }
  }

  async syncRequests(permissions, forms) {
    for (const [id] of this.permissions) if (!permissions.some((p) => p.id === id)) {
      this.permissions.delete(id);
      this.emit('requestResolved', { kind: 'permission', id });
    }
    for (const permission of permissions) {
      if (this.permissions.has(permission.id)) continue;
      this.permissions.set(permission.id, permission);
      const diffs = await nativeDiffs(permission.metadata, this.cwd, false);
      const input = await this.permissionInput(permission);
      if (this.closed) return;
      const options = [
        { optionId: 'once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Forbid' },
      ];
      this.emit('permission', { requestId: permission.id, sessionId: permission.sessionID, options,
        toolCall: { toolCallId: permission.source?.id || permission.id,
          title: permission.message || `${permission.action}: ${(permission.resources || []).join(', ')}`,
          kind: toolKind(permission.action), rawInput: input ?? permission.metadata, content: diffs },
        respond: (decision) => this.reply('permission', permission.id, 'POST',
          `/permission/${encodeURIComponent(permission.id)}/reply`, { decision: decision || 'reject' }, permission.sessionID),
      });
    }
    for (const [id] of this.forms) if (!forms.some((f) => f.id === id)) {
      this.forms.delete(id);
      this.emit('requestResolved', { kind: 'elicitation', id });
    }
    for (const form of forms) {
      if (this.forms.has(form.id)) continue;
      this.forms.set(form.id, form);
      this.emit('elicitation', { requestId: form.id, sessionId: form.sessionID, message: form.title,
        toolCallId: form.metadata?.toolCallID, requestedSchema: formSchema(form.fields),
        respond: (action, answer) => this.reply('elicitation', form.id,
          action === 'accept' ? 'POST' : 'DELETE',
          `/form/${encodeURIComponent(form.id)}${action === 'accept' ? '/reply' : ''}`,
          action === 'accept' ? { answer: formAnswer(form.fields, answer) } : undefined, form.sessionID),
      });
    }
  }

  async reply(kind, id, method, suffix, body, sessionId) {
    try {
      await this.request(method, suffix, body, sessionId);
      this.emit('requestResolved', { kind, id });
    } catch (error) {
      this.emit('notice', `Response failed: ${error.message}`);
      (kind === 'permission' ? this.permissions : this.forms).delete(id);
    }
    this.schedule();
  }

  async prompt(blocks, options = {}) {
    const id = options.id || messageID();
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    const files = blocks.filter((b) => b.type === 'image').map((b) => ({ uri: `data:${b.mimeType};base64,${b.data}` }));
    const item = { id, type: options.synthetic ? 'synthetic' : 'user', time: { created: Date.now() }, payload: { text, files } };
    if (options.synthetic) item.payload = { text, description: 'Editor continuation' };
    return this.submit(item);
  }

  async resend(id, payload) {
    // Native admission reconciles the same ID with queued or delivered work.
    // Cancelled inbox entries are removed, so that ID can be admitted again.
    const { text, files, agents, skills, metadata } = payload;
    return this.submit({ id, type: 'user', time: { created: Date.now() }, payload: {
      text, ...(files?.length ? { files } : {}), ...(agents?.length ? { agents } : {}),
      ...(skills?.length ? { skills } : {}), ...(metadata ? { metadata } : {}),
    } });
  }

  async submit(item) {
    const { id, type, payload } = item;
    const synthetic = type === 'synthetic';
    this.submissions.set(id, { item, state: 'sending' });
    this.revision++;
    if (!synthetic) this.emit('submission', { id, state: 'sending', item });
    try {
      const result = await this.request('POST', synthetic ? '/synthetic' : '/prompt', { ...payload, id, delivery: 'queue' });
      this.submissions.set(id, { item: result, state: 'queued' });
      this.revision++;
      if (!synthetic) this.emit('submission', { id, state: 'queued', item: result });
      this.full = true;
      await this.reconcile();
      return result;
    } catch (error) {
      // A lost HTTP response does not mean the durable admission failed. Keep
      // the ID so reconciliation can find it without inventing a second input.
      const state = error.statusCode && error.statusCode < 500 ? 'failed' : 'unknown';
      this.submissions.set(id, { item, state });
      if (!synthetic) this.emit('submission', { id, state, item, error: error.message });
      this.full = true;
      this.schedule();
      throw error;
    }
  }

  async refreshConfig() {
    const [info, models, agents] = await Promise.all([
      this.api.getSession(this.sessionId), this.api.listModels(this.cwd), this.api.listAgents(this.cwd),
    ]);
    // Like ACP's catalog, preserve server ordering: its resolved default is
    // the first visible primary agent. Session.agent only stores an override.
    const modes = agents.filter((agent) => !agent.hidden && agent.mode !== 'subagent');
    const model = info?.model || await this.api.getDefaultModel(this.cwd);
    // The switch endpoint may persist "default" explicitly rather than omit it.
    const variant = model?.variant !== 'default' ? model?.variant : undefined;
    this.modelRef = model ? { providerID: model.providerID, id: model.id,
      ...(variant ? { variant } : {}) } : null;
    const currentValue = model ? `${model.providerID}/${model.id}` : '';
    this.models = new Map();
    const options = [];
    for (const item of models.filter((m) => (!m.type || m.type === 'chat') && m.enabled !== false)) {
      const base = `${item.providerID}/${item.id}`;
      this.models.set(base, item);
      options.push({ value: base, name: `${item.providerID}/${item.name || item.id}` });
    }
    // An unresolved/unlisted selection must never look like the first catalog item.
    if (!this.models.has(currentValue)) options.unshift({ value: currentValue,
      name: currentValue || 'No default model available' });
    const variants = (this.models.get(currentValue)?.variants || []).flatMap((variant) => {
      const id = typeof variant === 'string' ? variant : variant.id;
      return id && id !== 'default' ? [{ value: id, name: id.charAt(0).toUpperCase() + id.slice(1) }] : [];
    });
    if (variant && !variants.some((item) => item.value === variant)) {
      variants.push({ value: variant, name: variant });
    }
    this.configOptions = [
      { id: 'mode', category: 'mode', type: 'select', name: 'Agent', currentValue: info?.agent || modes[0]?.id,
        options: modes.map((a) => ({ value: a.id, name: a.name })) },
      { id: 'model', category: 'model', type: 'select', name: 'Model',
        currentValue, options },
      ...(variants.length ? [{ id: 'effort', category: 'thought_level', type: 'select', name: 'Effort',
        description: 'Available effort levels for this model', currentValue: variant || 'default',
        options: [...variants, { value: 'default', name: 'Default' }] }] : []),
    ];
    this.emit('configOptions', this.configOptions);
  }

  async setConfigOption(id, value) {
    let model;
    if (id === 'model' && this.models.has(value)) {
      const item = this.models.get(value);
      model = { providerID: item.providerID, id: item.id };
      // ACP keeps effort for the same model, but resets it when switching models.
      if (this.modelRef?.providerID === model.providerID && this.modelRef.id === model.id && this.modelRef.variant) {
        model.variant = this.modelRef.variant;
      }
    } else if (id === 'effort' && this.modelRef && this.configOptions
      .find((option) => option.id === 'effort')?.options.some((option) => option.value === value)) {
      model = { providerID: this.modelRef.providerID, id: this.modelRef.id,
        ...(value !== 'default' ? { variant: value } : {}) };
    } else {
      throw new Error('Unknown model or effort selection');
    }
    await this.request('POST', '/model', { model });
    await this.refreshConfig();
    return this.configOptions;
  }

  async refreshBackground() {
    if (this.closed || !this.sessionId || !this.api.background) return;
    if (this.backgroundReading) { this.backgroundAgain = true; return; }
    clearTimeout(this.backgroundTimer);
    this.backgroundReading = true;
    let retry = false;
    try {
      const runs = await this.api.background.refresh(this.sessionId, this.cwd, [...this.messages.values()]);
      if (this.closed) return;
      this.emit('background', runs);
      retry = runs.some((run) => backgroundActive(run) || run.status === 'unknown');
    } catch (error) {
      this.log(`Background commands unavailable: ${error.message}`);
      retry = true;
    } finally {
      this.backgroundReading = false;
      if (!this.closed && (retry || this.backgroundAgain)) {
        const delay = this.backgroundAgain ? 0 : 2000;
        this.backgroundAgain = false;
        this.backgroundTimer = setTimeout(() => this.refreshBackground(), delay);
        this.backgroundTimer.unref?.();
      }
    }
  }

  async stopBackground(toolCallId) {
    if (!this.api.background) return;
    try {
      await this.api.background.stop(this.sessionId, this.cwd, toolCallId);
    } catch (error) {
      if (!this.closed) this.emit('backgroundStopError', { toolCallId, message: error.message });
    } finally { this.refreshBackground(); }
  }

  async cancel() {
    try {
      const pending = await this.request('GET', '/inbox');
      for (const item of pending) await this.request('DELETE', `/inbox/${encodeURIComponent(item.id)}`);
      await this.api.interruptSession(this.sessionId);
      this.schedule();
    } catch (error) { this.emit('notice', `Cannot stop: ${error.message}`); }
  }

  replay() {
    this.emitted.clear();
    this.permissions.clear();
    this.forms.clear();
    this.full = true;
    return this.reconcile();
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.backgroundTimer);
    this.stream?.dispose();
    // Detaching a tab is not a permission denial or an interrupt.
  }
}

module.exports = { SessionClient, toolUpdate, formSchema, formAnswer, messageID };

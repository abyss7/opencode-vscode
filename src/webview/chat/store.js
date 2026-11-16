'use strict';

/**
 * @file Layer 1: Normalized Session & History Store (`createChatStore`).
 *
 * Architectural contract:
 * - Pure data & state transitions ONLY. Zero `document`, `window`, or DOM access.
 * - Accepts inbound host messages and user intents, updates canonical slices
 *   (`session`, `turns`, `native`, `submissions`, `billing`, `composer`,
 *   `activity`, `subagents`, `files`), and produces a structured transaction
 *   descriptor (`ops` for the transcript renderer, `dirty` flags for shell
 *   views, and an explicit `scrollIntent` for the viewport controller).
 * - Can be instantiated and tested directly in Node (`test/webview-architecture.js`).
 */

const { prefixLine } = require('./format');
const {
  toolTitle,
  nativeImages,
} = require('./tool-metadata');
const { updateThoughtBlock, acceptsSummary, sameThought, thoughtCaption } = require('../../thought-caption');

const STATUS_LABELS = {
  connecting: 'Connecting…',
  ready: 'Ready',
  unconfirmed: 'Execution unconfirmed',
  busy: 'Working…',
  queued: 'Queued',
  cancelling: 'Stopping…',
  error: 'Error',
};

function createTransaction() {
  return {
    ops: [],
    dirty: {
      header: false,
      composer: false,
      usage: false,
      config: false,
      attachments: false,
      selection: false,
      slash: false,
      subagents: false,
      questions: false,
      fileChecks: false,
      title: false,
      archived: false,
      saveSession: false,
      saveSubmissions: false,
      saveViewport: false,
    },
    /** @type {null | { type: 'bottom' | 'follow' | 'restore' | 'historyEnd' | 'focusComposer', viewport?: object }} */
    scrollIntent: null,
  };
}

function isChildSessionUpdate(update) {
  const meta = update && update._meta;
  const child = meta && meta['opencode/child-session'];
  return Boolean(child && child.id);
}

function createChatStore({ initialViewport = null, initialSubmissions = [] } = {}) {
  let restoredViewport = initialViewport || null;
  let restoredSubmissions = Array.isArray(initialSubmissions) ? [...initialSubmissions] : [];

  const state = {
    // Session & connection lifecycle
    sessionId: null,
    cwd: null,
    title: '',
    connected: false,
    busy: false,
    externalBusy: false,
    archived: false,
    statusKind: 'connecting',
    statusText: STATUS_LABELS.connecting,
    imageSupport: false,
    nativeTransport: false,

    // Turn & replay state
    replaying: true,
    artifactSeq: 0,
    turnSeq: 0,
    turnId: null,
    turnHadText: false,
    turnEnded: false,
    pendingAssistantText: '',
    pendingAssistantId: null,
    thoughtBlocks: new Map(),
    thoughtSummaries: new Map(),
    thoughtTurnId: null,
    pendingThoughtId: null,
    pendingThoughtMessageId: null,
    thoughtSeq: 0,
    userMessageCount: 0,
    commandEchoIndex: -1,
    commandEchoText: '',
    skipUserIndex: -1,
    skipUserId: null,
    replaySeen: new Set(),

    // Normalized server snapshot & delivery state
    messageTimes: new Map(),
    nativeMessages: new Map(),
    nativeParts: new Map(),
    nativeDeliveredUsers: new Set(),
    nativeInbox: null,
    submissions: new Map(),

    // Async tool overlays
    backgroundRuns: new Map(),
    commandProgress: new Map(),
    smartReviews: new Map(),

    // Live header activity & attention queue
    currentAction: null,
    liveToolId: null,
    liveStartedAt: null,
    liveKey: null,
    activityPlan: '',
    activityThought: '',
    activityPurpose: '',
    attentionRequests: new Map(),

    // Context meter, cost ledger & provider quotas
    usage: null,
    cacheStats: null,
    costSplit: null,
    limits: null,
    budget: null,
    balance: null,
    modelLimit: null,
    subagentCost: 0,
    compaction: null,

    // Composer, attachments, selection & slash autocomplete
    images: [],
    nextImageId: 1,
    selection: null,
    selectionImages: [],
    acpCommands: [],
    restCommands: [],
    skills: [],
    slashItems: [],
    slashOpen: false,
    slashIndex: 0,
    configOptions: null,
    permissionProfile: null,

    // Sub-agents strip & file-link verification cache
    subagents: [],
    fileChecks: new Map(),
    fileCheckPending: new Set(),
  };

  function activeBackgroundRuns() {
    return [...state.backgroundRuns.values()].filter(
      (run) => run.status === 'running' || run.status === 'stopping'
    );
  }

  function currentAttention() {
    return state.attentionRequests.values().next().value || null;
  }

  function markLiveStart(key, startedAt) {
    const next = key || 'action';
    if (!state.liveStartedAt || state.liveKey !== next) {
      state.liveStartedAt = startedAt ?? Date.now();
      state.liveKey = next;
    }
  }

  function syncLiveFallback() {
    if (state.busy && !state.externalBusy && !state.currentAction) {
      markLiveStart('working');
    }
  }

  function setLiveAction(kind, text, key, summary, targetRef = null, startedAt = undefined) {
    state.currentAction = { kind, text, summary, targetRef };
    markLiveStart(key, startedAt);
  }

  function clearLiveAction() {
    state.currentAction = null;
    state.liveToolId = null;
    state.liveStartedAt = null;
    state.liveKey = null;
    syncLiveFallback();
  }

  function requestAttention(key, kind, summary, text, targetRef = null) {
    state.attentionRequests.set(key, {
      key,
      kind,
      summary,
      text,
      targetRef: targetRef || key,
      startedAt: Date.now(),
    });
  }

  function resolveAttention(key) {
    state.attentionRequests.delete(key);
    syncLiveFallback();
  }

  function beginTurn() {
    state.turnSeq += 1;
    state.turnId = `turn-${state.turnSeq}`;
    state.turnHadText = false;
    state.turnEnded = false;
    state.pendingAssistantText = '';
    state.pendingAssistantId = null;
    state.pendingThoughtId = null;
    state.pendingThoughtMessageId = null;
    state.thoughtBlocks.clear();
    state.thoughtSummaries.clear();
    state.thoughtTurnId = null;
    state.liveStartedAt = null;
    state.liveKey = null;
    state.currentAction = null;
    state.liveToolId = null;
    state.activityPlan = '';
    state.activityThought = '';
    state.activityPurpose = '';
  }

  function ensureTurnId() {
    if (state.turnEnded || !state.turnId) beginTurn();
    return state.turnId;
  }

  function setStatus(tx, kind, text, external = false) {
    state.statusKind = kind;
    state.externalBusy = Boolean(external && kind === 'busy');
    state.statusText = text || STATUS_LABELS[kind] || kind;
    state.connected =
      kind === 'ready' ||
      kind === 'unconfirmed' ||
      kind === 'busy' ||
      kind === 'queued' ||
      kind === 'cancelling';
    if (kind === 'busy' || kind === 'cancelling') state.busy = true;
    if (
      kind === 'ready' ||
      kind === 'queued' ||
      kind === 'unconfirmed' ||
      kind === 'error' ||
      kind === 'connecting'
    ) {
      state.busy = false;
    }
    // Status alone never settles streamed steps: "connecting"/"ready" flap on
    // reconnects while the server keeps working. Only semantic turn ends settle.
    if (!state.busy || state.externalBusy) {
      state.currentAction = null;
      state.liveToolId = null;
      state.liveStartedAt = null;
      state.liveKey = null;
      state.activityPlan = '';
      state.activityThought = '';
      state.activityPurpose = '';
      state.attentionRequests.clear();
    }
    if (state.busy && state.nativeTransport) syncThoughtCaption();
    syncLiveFallback();
    tx.dirty.header = true;
    tx.dirty.composer = true;
  }

  function resetTranscriptState(tx) {
    state.replaying = true;
    state.messageTimes.clear();
    state.artifactSeq = 0;
    state.pendingAssistantText = '';
    state.pendingAssistantId = null;
    state.pendingThoughtId = null;
    state.pendingThoughtMessageId = null;
    state.thoughtBlocks.clear();
    state.thoughtSummaries.clear();
    state.thoughtTurnId = null;
    state.backgroundRuns.clear();
    state.commandProgress.clear();
    state.turnId = null;
    state.turnSeq = 0;
    state.turnHadText = false;
    state.turnEnded = false;
    state.currentAction = null;
    state.liveToolId = null;
    state.liveStartedAt = null;
    state.liveKey = null;
    state.activityPlan = '';
    state.activityThought = '';
    state.activityPurpose = '';
    for (const key of [...state.attentionRequests.keys()]) {
      if (!String(key).startsWith('elicitation:')) state.attentionRequests.delete(key);
    }
    state.subagentCost = 0;
    state.userMessageCount = 0;
    state.replaySeen = new Set();
    state.skipUserId = null;
    if (state.commandEchoIndex >= 0) {
      state.skipUserIndex = state.commandEchoIndex;
      state.commandEchoIndex = -1;
    } else {
      state.skipUserIndex = -1;
    }
    state.nativeMessages.clear();
    state.nativeParts.clear();
    state.nativeDeliveredUsers.clear();
    tx.ops.push({ type: 'resetTranscript' });
    tx.dirty.header = true;
    tx.dirty.usage = true;
  }

  function buildSlashItems() {
    const items = [];
    const seenCommands = new Set();
    const addCommand = (command) => {
      const name = String((command && command.name) || '').trim();
      if (!name || seenCommands.has(name)) return;
      seenCommands.add(name);
      items.push({
        kind: 'command',
        name,
        description: String((command && command.description) || ''),
        insert: '/' + name + ' ',
      });
    };

    for (const command of state.acpCommands) addCommand(command);
    for (const command of state.restCommands) addCommand(command);

    for (const skill of state.skills) {
      const id = String((skill && skill.id) || '').trim();
      if (!id) continue;
      items.push({
        kind: 'skill',
        name: id,
        description: String((skill && (skill.description || skill.name)) || ''),
        insert: '@' + id + ' ',
      });
    }

    state.slashItems = items;
    return items;
  }

  function slashQuery(value, selectionStart, selectionEnd) {
    const text = String(value || '');
    const caret = selectionStart ?? text.length;
    if ((selectionEnd ?? caret) !== caret) return null;
    const before = text.slice(0, caret);
    const command = before.match(/^\/([^\s/]*)$/);
    const skill = before.match(/(?:^|\s)@([^\s@]*)$/);
    const match = command || skill;
    if (!match) return null;
    return {
      kind: command ? 'command' : 'skill',
      needle: match[1],
      start: caret - match[1].length - 1,
      end: caret + text.slice(caret).match(/^\S*/)[0].length,
    };
  }

  function filteredSlashItems(query) {
    if (!query) return [];
    const items = state.slashItems.filter((item) => item.kind === query.kind);
    const needle = query.needle.toLowerCase();
    if (!needle) return items;
    const startsWith = items.filter((item) => item.name.toLowerCase().startsWith(needle));
    if (startsWith.length > 0) return startsWith;
    return items.filter((item) => item.name.toLowerCase().includes(needle));
  }

  function knownCommand(text) {
    const match = String(text || '').match(/^\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const name = match[1];
    const exists = state.slashItems.some((item) => item.kind === 'command' && item.name === name);
    if (!exists) return null;
    return { name, text: String(match[2] || '').trim() };
  }

  function isSkippedReplayUser(tx, update) {
    if (state.skipUserIndex < 0) return false;
    const id = update.messageId || null;
    if (state.skipUserId) {
      if (!id || id === state.skipUserId) return true;
      state.skipUserId = null;
    }
    if (!state.replaySeen.has(id)) {
      state.replaySeen.add(id);
      if (state.replaySeen.size - 1 === state.skipUserIndex) {
        state.skipUserId = id;
        if (state.commandEchoText) {
          recordUserMessage(tx, state.commandEchoText, id, null, undefined);
        }
        return true;
      }
    }
    return false;
  }

  function finalizePendingAssistantState() {
    if (state.pendingAssistantText.trim()) {
      state.turnHadText = true;
    }
    state.pendingAssistantText = '';
    state.pendingAssistantId = null;
  }

  function syncThoughtCaption() {
    if (!state.busy || state.externalBusy || state.turnEnded) return;
    let caption = '';
    for (const block of state.thoughtBlocks.values()) {
      caption = thoughtCaption(block, state.thoughtSummaries.get(block.id)) || caption;
    }
    state.activityThought = caption;
  }

  function recordThoughtBlock(block) {
    state.thoughtTurnId ||= block.turnId;
    if (state.thoughtTurnId !== block.turnId) return;
    state.thoughtBlocks.set(block.id, block);
    syncThoughtCaption();
  }

  function applyThoughtSummary(summary, restoring = false) {
    if ((!state.busy && !restoring) || state.turnEnded || !summary) return;
    const latest = [...state.thoughtBlocks.values()].at(-1);
    const previous = state.thoughtSummaries.get(summary.id);
    if (!acceptsSummary(latest, summary) ||
        (sameThought(previous, summary) && previous.epoch === summary.epoch && previous.revision >= summary.revision)) return;
    state.thoughtSummaries.set(summary.id, summary);
    syncThoughtCaption();
  }

  // Only ACP needs boundary adaptation: native blocks already carry completion.
  function finalizePendingThoughtState() {
    const block = state.thoughtBlocks.get(state.pendingThoughtId);
    if (block) recordThoughtBlock(updateThoughtBlock(block, { ...block, completed: true }));
    state.pendingThoughtId = null;
    state.pendingThoughtMessageId = null;
  }

  function recordUserMessage(tx, text, messageId, images, timestamp) {
    finalizePendingThoughtState();
    finalizePendingAssistantState();
    const isAppend = Boolean(messageId && state.lastUserMessageId && state.lastUserMessageId === messageId);
    if (!isAppend) {
      beginTurn();
      state.thoughtTurnId = messageId || state.turnId;
      state.userMessageCount += 1;
      state.lastUserMessageId = messageId || null;
    }
    tx.ops.push({
      type: 'userMessage',
      text,
      messageId: messageId || null,
      images: images || null,
      timestamp,
    });
    tx.dirty.header = true;
  }

  function recordAssistantChunk(tx, content, messageId) {
    if (!content || content.type !== 'text' || typeof content.text !== 'string' || !content.text) {
      return;
    }
    finalizePendingThoughtState();
    if (messageId && state.pendingAssistantId && messageId !== state.pendingAssistantId) {
      finalizePendingAssistantState();
    }
    state.pendingAssistantId = messageId || state.pendingAssistantId || null;
    state.pendingAssistantText += content.text;
    state.liveToolId = null;
    setLiveAction('write', '', 'response:' + state.turnId, 'Writing response…', 'current-assistant');
    tx.ops.push({
      type: 'assistantChunk',
      text: content.text,
      messageId: messageId || null,
    });
    tx.dirty.header = true;
  }

  function recordThoughtChunk(tx, content, messageId) {
    if (!content || content.type !== 'text' || typeof content.text !== 'string' || !content.text) {
      return;
    }
    finalizePendingAssistantState();
    const pending = state.thoughtBlocks.get(state.pendingThoughtId);
    if (pending && messageId && state.pendingThoughtMessageId && messageId !== state.pendingThoughtMessageId) {
      finalizePendingThoughtState();
    }
    ensureTurnId();
    if (!state.pendingThoughtId) {
      state.pendingThoughtId = `acp-thought-${++state.thoughtSeq}`;
      state.pendingThoughtMessageId = messageId || null;
    }
    const previous = state.thoughtBlocks.get(state.pendingThoughtId);
    const block = updateThoughtBlock(previous, {
      sessionId: state.sessionId, turnId: state.thoughtTurnId || state.turnId,
      id: state.pendingThoughtId, text: (previous?.text || '') + content.text, completed: false,
    });
    recordThoughtBlock(block);
    state.liveToolId = null;
    setLiveAction('think', '', 'thought:' + state.turnId, 'Thinking…', 'current-thought');
    tx.ops.push({
      type: 'thoughtChunk',
      text: content.text,
      messageId: messageId || null,
      turnId: state.turnId,
    });
    tx.dirty.header = true;
  }

  function upsertSubmission(tx, submission) {
    if (!submission || !submission.id) return false;
    if (state.nativeDeliveredUsers.has(submission.id)) return false;
    let entry = state.submissions.get(submission.id);
    if (!entry) {
      if (!submission.item) return false;
      entry = {
        id: submission.id,
        state: submission.state,
        item: submission.item,
        cancellationConfirmed: submission.state === 'cancelled',
        error: submission.error || '',
      };
      state.submissions.set(submission.id, entry);
    } else {
      entry.state = submission.state;
      entry.cancellationConfirmed = submission.state === 'cancelled';
      entry.item = submission.item || entry.item;
      if (submission.error) entry.error = submission.error;
    }
    tx.ops.push({ type: 'upsertSubmission', entry: { ...entry } });
    tx.dirty.saveSubmissions = true;
    return true;
  }

  function reconcileSubmissions(tx) {
    if (!state.nativeInbox) return;
    for (const [id, entry] of state.submissions) {
      if (!state.nativeInbox.has(id) && entry.state === 'queued') {
        entry.state = 'unknown';
        tx.ops.push({ type: 'upsertSubmission', entry: { ...entry } });
      }
    }
  }

  function updateUsageState(tx, usage) {
    if (!usage || typeof usage !== 'object') return;
    const next = { ...(state.usage || {}) };
    if (typeof usage.used === 'number') next.used = usage.used;
    if (typeof usage.size === 'number' && usage.size > 0) next.size = usage.size;
    if (usage.cost && typeof usage.cost === 'object') next.cost = usage.cost;
    if (typeof usage.totalTokens === 'number') next.totalTokens = usage.totalTokens;
    if (typeof usage.inputTokens === 'number') next.inputTokens = usage.inputTokens;
    if (typeof usage.outputTokens === 'number') next.outputTokens = usage.outputTokens;
    if (typeof usage.thoughtTokens === 'number') next.thoughtTokens = usage.thoughtTokens;
    if (typeof usage.cachedReadTokens === 'number') next.cachedReadTokens = usage.cachedReadTokens;
    if (typeof usage.cachedWriteTokens === 'number') next.cachedWriteTokens = usage.cachedWriteTokens;
    state.usage = next;
    tx.dirty.usage = true;
  }

  function ingestAcpUpdate(tx, update) {
    if (!update || typeof update !== 'object') return;
    if (isChildSessionUpdate(update)) return;
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        if (isSkippedReplayUser(tx, update)) break;
        if (update.content && update.content.type === 'text' && typeof update.content.text === 'string') {
          if (!update.content.text) break;
          recordUserMessage(tx, update.content.text, update.messageId || null);
          tx.scrollIntent ||= { type: 'follow' };
        } else if (
          update.content?.type === 'image' &&
          typeof update.content.data === 'string' &&
          /^image\/(png|jpeg|gif|webp)$/.test(update.content.mimeType)
        ) {
          recordUserMessage(tx, '', update.messageId || null, [
            { name: 'Image', dataUrl: `data:${update.content.mimeType};base64,${update.content.data}` },
          ]);
          tx.scrollIntent ||= { type: 'follow' };
        }
        break;
      case 'agent_message_chunk':
        recordAssistantChunk(tx, update.content, update.messageId || null);
        tx.scrollIntent ||= { type: 'follow' };
        break;
      case 'agent_thought_chunk':
        recordThoughtChunk(tx, update.content, update.messageId || null);
        tx.scrollIntent ||= { type: 'follow' };
        break;
      case 'tool_call':
      case 'tool_call_update':
        if (update.toolCallId) {
          finalizePendingAssistantState();
          finalizePendingThoughtState();
          if (!(update.background || update.rawInput?.background)) ensureTurnId();
          else if (state.turnEnded || !state.turnId) beginTurn();
          tx.ops.push({ type: 'upsertTool', update, turnId: state.turnId });
          tx.dirty.header = true;
          tx.scrollIntent ||= { type: 'follow' };
        }
        break;
      case 'plan': {
        finalizePendingAssistantState();
        finalizePendingThoughtState();
        ensureTurnId();
        const entries = Array.isArray(update.entries) ? update.entries : [];
        state.activityPlan = entries.find((entry) => entry.status === 'in_progress')?.content || '';
        syncLiveFallback();
        tx.ops.push({ type: 'plan', entries, turnId: state.turnId });
        tx.dirty.header = true;
        tx.scrollIntent ||= { type: 'follow' };
        break;
      }
      case 'usage_update':
        updateUsageState(tx, update);
        break;
      case 'session_info_update':
        if (update.title) {
          state.title = update.title;
          tx.dirty.title = true;
        }
        break;
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          state.configOptions = update.configOptions;
          tx.dirty.config = true;
        }
        break;
      case 'available_commands_update':
        state.acpCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        buildSlashItems();
        tx.dirty.slash = true;
        break;
      default:
        break;
    }
  }

  function ingestTranscriptSnapshot(tx, snapshot) {
    state.nativeTransport = true;
    for (const message of snapshot.messages || []) {
      const signature = JSON.stringify(message);
      if (state.nativeMessages.get(message.id) === signature) continue;
      state.nativeMessages.set(message.id, signature);
      const stamp = message.time?.streamed || message.time?.created;
      if (Number.isFinite(stamp) && stamp > 0) state.messageTimes.set(message.id, stamp);

      tx.ops.push({ type: 'beginNativeMessage', messageId: message.id });

      if (message.type === 'user' && !state.nativeDeliveredUsers.has(message.id)) {
        state.submissions.delete(message.id);
        state.nativeDeliveredUsers.add(message.id);
        recordUserMessage(
          tx,
          message.text || '',
          message.id,
          nativeImages(message.files),
          message.time?.created
        );
        tx.ops.push({ type: 'markDeliveredUser', messageId: message.id });
      } else if (message.type === 'assistant') {
        for (const [index, part] of (message.content || []).entries()) {
          const key = `${message.id}:${index}`;
          const prev = state.nativeParts.get(key);
          if (part.type === 'tool') {
            const serialized = JSON.stringify(part.update);
            if (prev?.serialized !== serialized) {
              finalizePendingAssistantState();
              finalizePendingThoughtState();
              if (!(part.update?.background || part.update?.rawInput?.background)) ensureTurnId();
              else if (state.turnEnded || !state.turnId) beginTurn();
              tx.ops.push({ type: 'upsertTool', update: part.update, turnId: state.turnId });
              state.nativeParts.set(key, { type: 'tool', serialized });
              tx.dirty.header = true;
            }
          } else if (part.type === 'text' && part.text) {
            finalizePendingThoughtState();
            if (!prev) {
              state.pendingAssistantId = key;
              state.pendingAssistantText = part.text;
              state.liveToolId = null;
              setLiveAction('write', '', 'response:' + state.turnId, 'Writing response…', 'current-assistant');
            } else {
              state.pendingAssistantText = part.text;
            }
            const completed = Boolean(message.time?.completed);
            const newlyCompleted = completed && !prev?.completed;
            if (completed) {
              state.turnHadText = Boolean(part.text.trim()) || state.turnHadText;
              if (state.pendingAssistantId === key) {
                state.pendingAssistantId = null;
                state.pendingAssistantText = '';
              }
            }
            state.nativeParts.set(key, { type: 'text', text: part.text, completed: Boolean(prev?.completed || completed) });
            tx.ops.push({
              type: 'nativeAssistantText',
              key,
              messageId: message.id,
              text: part.text,
              timestamp: stamp,
              newlyCompleted,
            });
            tx.dirty.header = true;
          } else if (part.type === 'reasoning') {
            finalizePendingAssistantState();
            ensureTurnId();
            const block = part.thought || updateThoughtBlock(prev?.thought, {
              sessionId: state.sessionId, turnId: state.thoughtTurnId || state.turnId,
              id: key, text: part.text,
              completed: part.streamCompleted || Boolean(message.time?.completed) || index < message.content.length - 1,
            });
            if (!prev) {
              state.liveToolId = null;
              setLiveAction('think', '', 'thought:' + state.turnId, 'Thinking…', 'current-thought');
            }
            recordThoughtBlock(block);
            state.nativeParts.set(key, { type: 'reasoning', thought: block });
            if (block.text) tx.ops.push({
              type: 'nativeThought',
              key,
              block,
              turnId: state.turnId,
            });
            tx.dirty.header = true;
          }
        }
        if (message.time?.completed) {
          finalizePendingAssistantState();
          finalizePendingThoughtState();
          tx.ops.push({ type: 'finalizeStreamed' });
          tx.dirty.header = true;
        }
      } else if (message.type === 'idle') {
        finalizePendingAssistantState();
        finalizePendingThoughtState();
        state.thoughtBlocks.clear();
        state.thoughtSummaries.clear();
        state.thoughtTurnId = null;
        state.activityThought = '';
        tx.ops.push({ type: 'nativeIdle' });
        tx.dirty.header = true;
      }

      tx.ops.push({ type: 'endNativeMessage', messageId: message.id });
    }

    applyThoughtSummary(snapshot.thoughtSummary, true);
    if (snapshot.partial) {
      tx.ops.push({ type: 'placeSubmissions' });
      tx.scrollIntent = restoredViewport
        ? { type: 'restore', viewport: restoredViewport }
        : { type: 'follow' };
      return;
    }

    if (Array.isArray(snapshot.states)) {
      tx.ops.push({ type: 'syncNativeDelivery', states: snapshot.states });
    }
    state.nativeInbox = new Set((snapshot.inbox || []).map((item) => item.id));
    reconcileSubmissions(tx);
    for (const item of snapshot.inbox || []) {
      if (item.type !== 'user') continue;
      upsertSubmission(tx, { id: item.id, item, state: item.submissionState || 'queued' });
    }
    tx.ops.push({ type: 'placeSubmissions' });
    tx.dirty.saveSubmissions = true;
    tx.dirty.saveViewport = true;
    tx.scrollIntent = restoredViewport
      ? { type: 'restore', viewport: restoredViewport }
      : { type: 'follow' };
  }

  function addSmartReviewRecord(tx, review) {
    if (!review || !review.id) return;
    const previous = state.smartReviews.get(review.id);
    const signature = JSON.stringify(review);
    const unchanged = previous?.signature === signature;
    const record = { id: review.id, signature, review };
    state.smartReviews.set(review.id, record);
    tx.ops.push({ type: 'smartReview', review, unchanged });
    if (!unchanged) tx.scrollIntent ||= { type: 'follow' };
  }

  /**
   * Primary reducer: processes any host message and returns a declarative
   * transaction without touching the DOM.
   */
  function ingestHostMessage(message) {
    const tx = createTransaction();
    if (!message || typeof message.type !== 'string') return tx;

    switch (message.type) {
      case 'status':
        setStatus(tx, message.state, message.message, message.external);
        break;
      case 'background':
        state.backgroundRuns = new Map((message.runs || []).map((run) => [run.toolCallId, run]));
        syncLiveFallback();
        tx.ops.push({ type: 'syncBackgroundRuns' });
        tx.dirty.header = true;
        break;
      case 'commandProgress':
        state.commandProgress = new Map((message.items || []).map((item) => [item.toolCallId, item]));
        tx.ops.push({ type: 'syncCommandProgress' });
        break;
      case 'backgroundStopError': {
        const run = state.backgroundRuns.get(message.toolCallId);
        if (run?.status === 'stopping') run.status = 'running';
        tx.ops.push({
          type: 'backgroundStopError',
          toolCallId: message.toolCallId,
          message: message.message,
        });
        tx.dirty.header = true;
        break;
      }
      case 'session': {
        const previousId = state.sessionId;
        state.sessionId = message.sessionId || null;
        if (message.cwd) state.cwd = message.cwd;
        if (previousId && previousId !== state.sessionId) {
          state.smartReviews.clear();
          tx.ops.push({ type: 'clearSmartReviews' });
        }
        for (const submission of restoredSubmissions) {
          if (state.submissions.has(submission.id)) continue;
          const unconfirmed =
            submission.state === 'sending' ||
            (submission.state === 'cancelled' && !submission.cancellationConfirmed);
          upsertSubmission(tx, { ...submission, state: unconfirmed ? 'unknown' : submission.state });
        }
        restoredSubmissions = [];
        reconcileSubmissions(tx);
        tx.ops.push({ type: 'placeSubmissions' });
        tx.dirty.composer = true;
        tx.dirty.saveSession = true;
        tx.dirty.saveSubmissions = true;
        break;
      }
      case 'capabilities':
        state.imageSupport = Boolean(message.images);
        state.nativeTransport = message.transport === 'server';
        tx.dirty.attachments = true;
        break;
      case 'transcript':
        ingestTranscriptSnapshot(tx, message);
        break;
      case 'submission':
        if (upsertSubmission(tx, message)) {
          tx.ops.push({ type: 'placeSubmissions' });
          tx.scrollIntent ||= { type: 'follow' };
        }
        break;
      case 'requestResolved': {
        resolveAttention(`permission:${message.requestId}`);
        resolveAttention(`elicitation:${message.requestId}`);
        tx.ops.push({ type: 'requestResolved', requestId: String(message.requestId) });
        tx.dirty.header = true;
        tx.dirty.questions = true;
        tx.dirty.composer = true;
        break;
      }
      case 'slashItems':
        state.skills = Array.isArray(message.skills) ? message.skills : [];
        state.restCommands = Array.isArray(message.commands) ? message.commands : [];
        buildSlashItems();
        tx.dirty.slash = true;
        break;
      case 'historyReset':
        resetTranscriptState(tx);
        break;
      case 'messageTimes':
        for (const { id, timestamp } of message.times || []) {
          if (id && Number.isFinite(timestamp) && timestamp > 0) {
            state.messageTimes.set(id, timestamp);
          }
        }
        tx.ops.push({ type: 'syncMessageTimes' });
        break;
      case 'sessionInfo':
        if (message.title) {
          state.title = message.title;
          tx.dirty.title = true;
        }
        if (typeof message.archived === 'boolean') {
          state.archived = Boolean(message.archived);
          if (state.archived) {
            for (const key of [...state.attentionRequests.keys()]) {
              if (String(key).startsWith('elicitation:')) state.attentionRequests.delete(key);
            }
            syncLiveFallback();
            state.images = [];
            state.selection = null;
            state.selectionImages = [];
            state.slashOpen = false;
            state.slashIndex = 0;
            tx.dirty.attachments = true;
            tx.dirty.selection = true;
            tx.dirty.slash = true;
            tx.dirty.questions = true;
            tx.dirty.header = true;
          }
          tx.dirty.archived = true;
          tx.dirty.composer = true;
        }
        break;
      case 'focus':
        tx.scrollIntent = { type: 'focusComposer' };
        break;
      case 'config':
        state.configOptions = message.configOptions;
        tx.dirty.config = true;
        break;
      case 'limits':
        if (
          message.model &&
          state.modelLimit?.model &&
          (message.model.providerID !== state.modelLimit.model.providerID ||
            message.model.id !== state.modelLimit.model.id)
        ) {
          break;
        }
        state.limits = message.limits || null;
        state.budget = message.budget || null;
        tx.dirty.usage = true;
        break;
      case 'balance':
        if (
          message.model &&
          state.modelLimit?.model &&
          (message.model.providerID !== state.modelLimit.model.providerID ||
            message.model.id !== state.modelLimit.model.id)
        ) {
          break;
        }
        state.balance = message.balance || null;
        tx.dirty.usage = true;
        break;
      case 'smartReviews':
        for (const review of message.reviews || []) addSmartReviewRecord(tx, review);
        break;
      case 'permissionProfile':
        state.permissionProfile = message;
        tx.dirty.config = true;
        break;
      case 'permissionRuleResult':
        if (!message.error) resolveAttention(`permission:${message.requestId}`);
        tx.ops.push({ type: 'permissionRuleResult', message });
        tx.dirty.header = true;
        break;
      case 'modelLimit':
        if (
          message.model &&
          (message.model.providerID !== state.modelLimit?.model?.providerID ||
            message.model.id !== state.modelLimit?.model?.id)
        ) {
          state.balance = null;
          state.budget = null;
          state.limits = null;
        }
        state.modelLimit = {
          model: message.model,
          billing: message.billing,
          context: Number(message.context) || 0,
          input: Number(message.input) || 0,
          subscription: message.subscription === true,
        };
        tx.dirty.usage = true;
        break;
      case 'cacheStats':
        state.cacheStats =
          Number(message.prompt) > 0
            ? {
                prompt: Number(message.prompt) || 0,
                input: Number(message.input) || 0,
                read: Number(message.read) || 0,
                write: Number(message.write) || 0,
                at: Number(message.at) || 0,
              }
            : null;
        tx.dirty.usage = true;
        break;
      case 'costSplit':
        state.costSplit =
          message && Array.isArray(message.rows)
            ? {
                model: message.model,
                total: Number(message.total) || 0,
                rows: message.rows.map((row) => ({
                  key: String(row.key || ''),
                  label: String(row.label || row.key || ''),
                  tokens: Number(row.tokens) || 0,
                  cost: Number(row.cost) || 0,
                })),
              }
            : null;
        tx.dirty.usage = true;
        break;
      case 'compaction':
        state.compaction = message.compaction || null;
        tx.dirty.usage = true;
        break;
      case 'update':
        ingestAcpUpdate(tx, message.update);
        break;
      case 'thoughtCaption':
        applyThoughtSummary(message.summary);
        tx.dirty.header = true;
        break;
      case 'permission': {
        finalizePendingAssistantState();
        finalizePendingThoughtState();
        const key = `permission:${message.requestId}`;
        requestAttention(key, 'permission', 'Waiting for approval', toolTitle(message.toolCall));
        tx.ops.push({ type: 'permission', message, attentionKey: key });
        tx.dirty.header = true;
        tx.dirty.fileChecks = true;
        tx.scrollIntent ||= { type: 'follow' };
        break;
      }
      case 'elicitation': {
        if (state.archived) break;
        finalizePendingAssistantState();
        finalizePendingThoughtState();
        const key = `elicitation:${message.requestId}`;
        requestAttention(
          key,
          'question',
          'Waiting for your answer',
          prefixLine(message.message || 'Question')
        );
        tx.ops.push({ type: 'elicitation', message, attentionKey: key });
        tx.dirty.header = true;
        tx.dirty.questions = true;
        tx.dirty.composer = true;
        break;
      }
      case 'fileChecks':
        if (Array.isArray(message.files)) {
          for (const result of message.files) {
            if (!result || typeof result.key !== 'string') continue;
            state.fileChecks.set(result.key, result.exists === true);
            state.fileCheckPending.delete(result.key);
          }
          tx.dirty.fileChecks = true;
        }
        break;
      case 'historyEnd': {
        state.replaying = false;
        state.skipUserIndex = -1;
        state.skipUserId = null;
        state.commandEchoText = '';
        finalizePendingAssistantState();
        finalizePendingThoughtState();
        tx.ops.push({ type: 'historyEnd' });
        tx.dirty.header = true;
        if (restoredViewport) {
          const viewport = restoredViewport;
          restoredViewport = null;
          tx.scrollIntent = { type: 'historyEnd', viewport };
        } else {
          tx.scrollIntent = { type: 'historyEnd', viewport: null };
        }
        break;
      }
      case 'turnEnd': {
        const fresh = !state.turnEnded;
        finalizePendingAssistantState();
        finalizePendingThoughtState();
        const hadText = state.turnHadText;
        state.busy = false;
        if (message.usage) updateUsageState(tx, message.usage);
        if (fresh) state.turnEnded = true;
        tx.ops.push({
          type: 'turnEnd',
          fresh,
          hadText,
          turnId: state.turnId,
          usage: message.usage || null,
          stopReason: message.stopReason,
        });
        setStatus(tx, 'ready');
        tx.scrollIntent ||= { type: 'follow' };
        break;
      }
      case 'turnStats':
        tx.ops.push({
          type: 'turnStats',
          turns: message.turns,
          scope: message.scope,
          currentTurnId: state.turnId || '',
        });
        break;
      case 'subagents':
        state.subagentCost = Number(message.totalCost) || 0;
        state.subagents = Array.isArray(message.items) ? message.items : [];
        tx.dirty.subagents = true;
        tx.dirty.usage = true;
        break;
      case 'info':
        if (message.text) {
          tx.ops.push({ type: 'info', text: message.text });
          tx.scrollIntent ||= { type: 'follow' };
        }
        break;
      case 'error':
        if (message.message) {
          finalizePendingThoughtState();
          finalizePendingAssistantState();
          state.statusKind = 'error';
          state.statusText = message.message;
          state.busy = false;
          state.activityPlan = '';
          state.activityThought = '';
          state.activityPurpose = '';
          state.attentionRequests.clear();
          clearLiveAction();
          tx.ops.push({ type: 'error', text: message.message });
          tx.dirty.header = true;
          tx.dirty.composer = true;
          tx.scrollIntent ||= { type: 'follow' };
        }
        break;
      default:
        break;
    }

    return tx;
  }

  /**
   * Prepare user prompt or slash command submission. Mutates store state and
   * returns `{ tx, outbound }` so the coordinator can run DOM + scroll + postMessage.
   */
  function prepareSend(rawText, makeId) {
    const tx = createTransaction();
    if (state.archived) return { tx, outbound: null };
    const text = String(rawText || '').trim();
    const images = [...state.images, ...state.selectionImages];
    const selection = state.selection;
    const wasBusy = state.busy;
    if ((!text && images.length === 0) || !state.connected) return { tx, outbound: null };
    if (wasBusy && images.length > 0 && !state.nativeTransport) {
      tx.ops.push({ type: 'info', text: 'Image attachments cannot be queued while OpenCode is working.' });
      tx.scrollIntent = { type: 'follow' };
      return { tx, outbound: null };
    }
    const candidate = images.length > 0 || selection ? null : knownCommand(text);
    const command = !wasBusy || candidate?.name === 'archive' ? candidate : null;
    const id = state.nativeTransport ? makeId() : null;
    const now = Date.now();

    if (state.nativeTransport && !command) {
      upsertSubmission(tx, {
        id,
        state: 'sending',
        item: {
          id,
          time: { created: now },
          ...(selection ? { selection } : {}),
          payload: {
            text,
            files: images.map((image) => ({
              uri: image.dataUrl || `data:${image.mimeType};base64,${image.data}`,
            })),
          },
        },
      });
      tx.ops.push({ type: 'placeSubmissions' });
    } else {
      recordUserMessage(tx, text, null, images, now);
    }

    if (command) {
      state.commandEchoIndex = state.userMessageCount - 1;
      state.commandEchoText = text;
    }

    state.images = [];
    if (selection) {
      state.selection = null;
      state.selectionImages = [];
      tx.dirty.selection = true;
    }
    state.slashOpen = false;
    state.slashIndex = 0;
    tx.dirty.attachments = true;
    tx.dirty.slash = true;

    if (!wasBusy && state.nativeTransport && !command) {
      setStatus(tx, 'queued');
    } else if (!wasBusy) {
      state.busy = true;
      if (!state.liveStartedAt) {
        state.liveStartedAt = now;
        state.liveKey = 'working';
      }
      setStatus(tx, 'busy');
    }
    tx.dirty.composer = true;
    // Sending is deliberate navigation: always reveal the newly submitted turn.
    tx.scrollIntent = { type: 'bottom' };

    const outbound = command
      ? { type: 'command', name: command.name, text: command.text }
      : {
          type: 'prompt',
          ...(id ? { id } : {}),
          text,
          ...(selection ? { selection } : {}),
          images: images.map((image) => ({
            data: image.data,
            mimeType: image.mimeType,
            name: image.name,
          })),
        };

    return { tx, outbound, clearedInput: true };
  }

  function prepareResend(id) {
    const tx = createTransaction();
    const entry = state.submissions.get(id);
    if (!entry?.item || !['unknown', 'failed', 'cancelled'].includes(entry.state)) {
      return { tx, outbound: null };
    }
    const item = entry.item;
    upsertSubmission(tx, { id, state: 'sending', item });
    tx.ops.push({ type: 'placeSubmissions' });
    tx.scrollIntent = { type: 'follow' };
    return { tx, outbound: { type: 'resend', item } };
  }

  function prepareStop() {
    const tx = createTransaction();
    if (!state.busy) return { tx, outbound: null };
    setStatus(tx, 'cancelling');
    return { tx, outbound: { type: 'cancel' } };
  }

  return {
    STATUS_LABELS,
    state,
    get hasRestoredViewport() { return Boolean(restoredViewport); },
    activeBackgroundRuns,
    currentAttention,
    setLiveAction,
    clearLiveAction,
    syncLiveFallback,
    resolveAttention,
    buildSlashItems,
    slashQuery,
    filteredSlashItems,
    knownCommand,
    addSmartReviewRecord,
    ingestHostMessage,
    prepareSend,
    prepareResend,
    prepareStop,
    serializeSubmissions() {
      return [...state.submissions].map(([id, entry]) => ({
        id,
        state: entry.state,
        item: entry.item,
        cancellationConfirmed: entry.cancellationConfirmed,
      }));
    },
  };
}

module.exports = { createChatStore, STATUS_LABELS, isChildSessionUpdate };

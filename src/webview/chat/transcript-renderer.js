'use strict';

/**
 * @file Layer 2 Reconciler: Transcript DOM & Step Disclosure Controller.
 *
 * Architectural contract:
 * - Consumes declarative `ops` emitted by `ChatStore` (Layer 1) and projects
 *   them into `#messages`.
 * - Owns all DOM node maps (`toolCards`, `turnSteps`, `toolGroup`, `thoughtLayouts`,
 *   `stickyPrompt`, `submissionNodes`) and the deferred-fold queue (`pendingFolds`).
 * - NEVER writes `scrollTop` or calls `scrollToBottom()`. Scroll/anchor locking
 *   is owned exclusively by `TranscriptViewport` (Layer 3), which wraps each
 *   reconcile pass in `beginMutation()` / `endMutation()`.
 * - Step auto-folding asks `canFold(detailsEl)` (`!viewport.foldingMoves(el)`):
 *   when a fold would disturb a parked reader, it is queued in `pendingFolds`
 *   and applied cleanly once `following` resumes.
 */

const { el } = require('./dom');
const { isLayoutHidden } = require('../layout-visibility');
const {
  estimateTokens,
  formatCompact,
  formatTokens,
  formatTurnTokens,
} = require('./format');
const {
  toolStatusLabel,
  isSubagentTool,
  subagentLabel,
  toolInputText,
  toolContentText,
  summarizeTools,
  describeToolAction,
  noTextAnswer,
} = require('./tool-metadata');
const { syncBackgroundPulse } = require('./header-view');

const INPUT_STATUS_LABELS = {
  sending: 'Sending…',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  unknown: 'Delivery unconfirmed',
};

function isAssistantMessage(node) {
  const classes = String(node.className || '').split(/\s+/);
  return classes.includes('message') && classes.includes('assistant');
}

function countBlockSteps(block) {
  if (!block) return 0;
  const body = block.querySelector('.body');
  if (!body) return 0;
  let count = 0;
  for (const child of body.children) {
    const classes = String(child.className || '').split(/\s+/);
    if (classes.includes('tool-group')) {
      count += child.querySelectorAll('.tool-entry').length;
    } else {
      count += 1;
    }
  }
  return count;
}

function createToolRow(body, label) {
  const row = el('div', 'tool-row');
  row.hidden = true;
  const labelEl = el('div', 'tool-label', label);
  const contentEl = el('div', 'tool-content');
  row.appendChild(labelEl);
  row.appendChild(contentEl);
  body.appendChild(row);
  return { row, contentEl };
}

function setToolPre(row, text) {
  let pre = row.contentEl.querySelector('pre');
  if (!pre) {
    pre = el('pre');
    row.contentEl.appendChild(pre);
  }
  pre.textContent = text;
  row.row.hidden = false;
}

function createTranscriptRenderer({
  store,
  messagesEl,
  emptyEl,
  planProgressEl,
  richText,
  timeFormat,
  artifacts,
  renderMarkdown,
  scheduleFileChecks,
  permissionsView,
  focusLocal,
  canFold,
  isFollowing,
  onAsyncLayout,
  onResendSubmission,
  postMessage,
}) {
  let anchorSeq = 0;
  let currentAssistant = null;
  let currentThought = null;
  let lastUser = null;
  let toolGroup = null;
  let turnSteps = null;
  let planEl = null;
  let stickyPrompt = null;
  let stickyTarget = null;
  let activeNativeMessageId = null;
  let nativeBeforeChildren = null;
  let initialRender = null;

  const toolCards = new Map();
  const nativeAssistants = new Map();
  const nativeThoughts = new Map();
  const nativeUsers = new Map();
  const submissionNodes = new Map();
  const pendingFolds = new Map();

  // Single-line compact thought measurement
  const thoughtLayouts = new WeakMap();
  const thoughtMeasure =
    typeof ResizeObserver === 'function' ? document.createElement('canvas').getContext('2d') : null;
  const thoughtResize = thoughtMeasure
    ? new ResizeObserver((entries) => {
        syncThoughtLayouts(entries.map(({ target }) => thoughtLayouts.get(target)));
      })
    : null;

  function assignAcpAnchor(node, prefix = 'block') {
    if (!activeNativeMessageId && !node.dataset.anchorId) {
      node.dataset.anchorId = `${prefix}-${++anchorSeq}`;
    }
  }

  function hideEmpty() {
    if (emptyEl) emptyEl.hidden = true;
  }

  // --- Message timestamps & overnight day rollover ---

  function formatMessageTime(timestamp) {
    return timeFormat.formatTimestamp(timestamp, { seconds: true });
  }

  function setMessageTime(wrap, timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) {
      return;
    }
    let time = wrap.querySelector(':scope > .message-time');
    if (!time) {
      time = el('time', 'message-time');
      wrap.prepend(time);
    }
    time.dataset.timestamp = String(timestamp);
    time.dateTime = new Date(timestamp).toISOString();
    time.textContent = formatMessageTime(timestamp);
    time.title = timeFormat.formatFull(timestamp);
  }

  function stampMessage(wrap, messageId, timestamp) {
    if (messageId) wrap.dataset.messageId = messageId;
    setMessageTime(
      wrap,
      store.state.messageTimes.get(messageId) ||
        timestamp ||
        (store.state.replaying ? 0 : Date.now())
    );
  }

  function syncMessageTimes() {
    for (const wrap of messagesEl.querySelectorAll('.message[data-message-id]')) {
      setMessageTime(wrap, store.state.messageTimes.get(wrap.dataset.messageId));
    }
  }

  let messageTimeDay = new Date().toDateString();
  const messageTimeClock = setInterval(() => {
    const day = new Date().toDateString();
    if (day === messageTimeDay) return;
    messageTimeDay = day;
    for (const time of messagesEl.querySelectorAll('.message-time')) {
      time.textContent = formatMessageTime(Number(time.dataset.timestamp));
    }
  }, 1000);
  messageTimeClock.unref?.();

  // --- Sticky prompt overhang ---

  function updateStickyVisibility() {
    if (!messagesEl.isConnected || !stickyPrompt || !stickyTarget || !messagesEl.contains(stickyTarget)) return;
    const above = stickyTarget.getBoundingClientRect().bottom <= messagesEl.getBoundingClientRect().top;
    stickyPrompt.classList.toggle('visible', above);
    stickyPrompt.querySelector('button').tabIndex = above ? 0 : -1;
  }

  function updateStickyPrompt() {
    if (initialRender) {
      initialRender.sticky = true;
      return;
    }
    if (typeof Element === 'undefined') return;
    const target = [...messagesEl.children].reverse().find((node) => node.matches?.('.message.user'));
    if (target === stickyTarget && messagesEl.contains(stickyPrompt)) {
      const button = stickyPrompt.querySelector('button');
      const text = target.querySelector('.body')?.textContent || 'Latest prompt';
      if (button.textContent !== text) button.textContent = text;
      if (target.nextSibling !== stickyPrompt) messagesEl.insertBefore(stickyPrompt, target.nextSibling);
      updateStickyVisibility();
      return;
    }
    stickyPrompt?.remove();
    stickyTarget = target;
    if (!target) {
      stickyPrompt = null;
      return;
    }
    stickyPrompt = el('div', 'sticky-prompt');
    // Bulk construction creates this after the native message's end marker.
    // Preserve the same anchor as the incremental prompt+sticky insertion.
    if (target.dataset.messageId) stickyPrompt.dataset.anchorId = `${target.dataset.messageId}:1`;
    const button = el('button', '', target.querySelector('.body')?.textContent || 'Latest prompt');
    button.type = 'button';
    button.title = 'Go to latest prompt';
    button.setAttribute('aria-label', 'Go to latest prompt');
    button.addEventListener('click', () => {
      richText.scrollToElement(messagesEl, target, { block: 'start', behavior: 'smooth' });
      target.tabIndex = -1;
      focusLocal(target);
    });
    stickyPrompt.appendChild(button);
    messagesEl.insertBefore(stickyPrompt, target.nextSibling);
    updateStickyVisibility();
  }

  messagesEl.addEventListener('scroll', updateStickyVisibility, { passive: true });

  // --- Deferred Folds & Turn Steps ---

  function deferFold(details, open) {
    pendingFolds.set(details, open);
  }

  function setStepsLive(details, live) {
    if (!details) return;
    if (live) {
      pendingFolds.delete(details);
    } else if (!initialRender && !canFold(details)) {
      deferFold(details, false);
      return;
    }
    details.classList.toggle('live', live);
    details.open = live;
    if (live) details.querySelector(':scope > .disclosure-collapse')?.remove();
  }

  function applyPendingFolds() {
    if (!isFollowing() || !pendingFolds.size) return;
    const blocks = [...pendingFolds];
    pendingFolds.clear();
    for (const [block, open] of blocks) {
      if (messagesEl.contains(block)) {
        block.classList.remove('live');
        block.open = open;
        settleStandaloneTasks(block);
      }
    }
  }

  function createTurnStepsBlock(turn, before = null) {
    const details = document.createElement('details');
    details.className = 'turn-steps';
    details.dataset.turn = turn || '';
    details.open = false;
    assignAcpAnchor(details, 'steps');
    const summary = document.createElement('summary');
    const titleEl = el('span', 'kind', 'Steps');
    const metaEl = el('span', 'name step-metrics', '');
    const tokensEl = el('span', 'tokens', '');
    summary.appendChild(titleEl);
    summary.appendChild(metaEl);
    summary.appendChild(tokensEl);
    const body = el('div', 'body');
    details.appendChild(summary);
    details.appendChild(body);
    messagesEl.insertBefore(details, before);
    return { details, body, titleEl, metaEl, tokensEl };
  }

  function ensureTurnSteps(turnId) {
    if (turnSteps) return turnSteps;
    turnSteps = createTurnStepsBlock(turnId || store.state.turnId || '');
    setStepsLive(turnSteps.details, true);
    store.syncLiveFallback();
    return turnSteps;
  }

  function turnToolCards(details) {
    return [...details.querySelectorAll('.tool-entry')]
      .map((entry) => toolCards.get(entry.dataset.toolCallId))
      .filter(Boolean);
  }

  function renderStepSummary(titleEl, metaEl, cards, count = cards.length) {
    const summary = summarizeTools(cards, store.state.cwd || '');
    titleEl.textContent = `${count} step${count === 1 ? '' : 's'}`;
    metaEl.classList.add('step-metrics');
    const metrics = [...summary.metrics, ...summary.statusMetrics];
    metaEl.replaceChildren(...metrics.map((text) => el('span', 'step-metric', text)));
  }

  function syncTurnSteps() {
    if (!turnSteps) return;
    if (initialRender) {
      initialRender.steps.add(turnSteps);
      return;
    }
    syncStepSummary(turnSteps);
  }

  function syncStepSummary(steps) {
    if (steps.details.classList.contains('live')) steps.details.open = true;
    let totalTokens = 0;
    for (const child of steps.body.children) {
      const classes = String(child.className || '').split(/\s+/);
      if (classes.includes('tool-group')) {
        totalTokens += Number(child.dataset.tokens || 0);
      } else {
        const ownTokens = Number(child.dataset.tokens || 0);
        totalTokens +=
          ownTokens > 0
            ? ownTokens
            : isAssistantMessage(child)
              ? estimateTokens(child.textContent)
              : 0;
      }
    }
    renderStepSummary(
      steps.titleEl,
      steps.metaEl,
      turnToolCards(steps.details),
      countBlockSteps(steps.details)
    );
    if (steps.details.dataset.exact !== '1') {
      steps.tokensEl.textContent = totalTokens ? formatTokens(totalTokens) : '';
      steps.tokensEl.title = totalTokens ? 'Estimated tokens for this turn' : '';
    }
  }

  function finalizeTurnSteps() {
    if (!turnSteps) return;
    syncTurnSteps();
    const block = turnSteps.details;
    // Drop the live-tail reference before folding: lifting a still-running
    // background command out must not re-open a tail for a settled turn.
    turnSteps = null;
    setStepsLive(block, false);
    settleStandaloneTasks(block);
  }

  function settleLiveSteps() {
    if (turnSteps) finalizeTurnSteps();
    for (const block of messagesEl.querySelectorAll('.turn-steps.live')) {
      setStepsLive(block, false);
      settleStandaloneTasks(block);
    }
  }

  function beginIntermediate(turnId) {
    const steps = ensureTurnSteps(turnId);
    syncTurnSteps();
    return steps;
  }

  function currentTurnBlocks(turnId) {
    const turn = turnId || store.state.turnId || '';
    return Array.from(messagesEl.querySelectorAll('.turn-steps')).filter(
      (block) => (block.dataset.turn || '') === turn
    );
  }

  function turnStepGroups() {
    const groups = [];
    const byTurn = new Map();
    for (const block of messagesEl.querySelectorAll('.turn-steps')) {
      const turn = block.dataset.turn || '';
      if (!turn) {
        groups.push([block]);
        continue;
      }
      let group = byTurn.get(turn);
      if (!group) {
        group = [];
        byTurn.set(turn, group);
        groups.push(group);
      }
      group.push(block);
    }
    return groups;
  }

  function applyTurnStat(details, stat) {
    if (!details || !stat) return;
    if (details.dataset.exact === '1') return;
    const summary = details.querySelector('summary');
    if (!summary) return;
    const titleEl = summary.querySelector(':scope > .kind');
    const metaEl = summary.querySelector(':scope > .name');
    const tokensEl = summary.querySelector(':scope > .tokens');
    const totalTokens = Number(stat.tokens) || 0;
    if (titleEl && metaEl) {
      renderStepSummary(
        titleEl,
        metaEl,
        turnToolCards(details),
        Number(stat.steps) || countBlockSteps(details)
      );
    }
    details.dataset.tokens = String(totalTokens);
    if (tokensEl) {
      const exact = stat.exact === true;
      tokensEl.textContent = formatTurnTokens(totalTokens, stat.cacheRead, stat.cacheWrite, exact);
      tokensEl.title = totalTokens
        ? exact
          ? 'Billed tokens for this turn, read back from the server history'
          : 'Estimated tokens for this turn, rebuilt from the server history'
        : '';
    }
    if (stat.exact === true) details.dataset.exact = '1';
  }

  function applyTurnStats(turns, scope, currentTurnId) {
    if (!Array.isArray(turns) || turns.length === 0) return;
    const groups = turnStepGroups();
    if (groups.length === 0) return;
    const hasStandalone = (group) =>
      [...toolCards.values()].some(
        (card) => (card.background || card.progressVisible) && card.activityTurn === group[0].dataset.turn
      );
    if (scope === 'last') {
      const group = groups[groups.length - 1];
      if (turnSteps && group.includes(turnSteps.details)) return;
      const turn = group[0].dataset.turn || '';
      if (turn !== currentTurnId) return;
      if (group.length === 1 && !hasStandalone(group)) applyTurnStat(group[0], turns[turns.length - 1]);
      return;
    }
    const count = Math.min(groups.length, turns.length);
    const groupStart = groups.length - count;
    const turnStart = turns.length - count;
    for (let index = 0; index < count; index += 1) {
      const group = groups[groupStart + index];
      if (group.length !== 1 || hasStandalone(group)) continue;
      applyTurnStat(group[0], turns[turnStart + index]);
    }
  }

  function applyBilledUsage(usage, block) {
    if (!usage || typeof usage.totalTokens !== 'number' || usage.totalTokens <= 0 || !block) return;
    const summary = block.querySelector('summary');
    if (!summary) return;
    const tokensEl = summary.querySelector(':scope > .tokens');
    block.dataset.tokens = String(usage.totalTokens);
    block.dataset.exact = '1';
    if (!tokensEl) return;
    tokensEl.textContent = formatTurnTokens(
      usage.totalTokens,
      usage.cachedReadTokens,
      usage.cachedWriteTokens,
      true
    );
    const parts = [];
    if (typeof usage.inputTokens === 'number') parts.push(`input ${formatCompact(usage.inputTokens)}`);
    if (typeof usage.outputTokens === 'number') parts.push(`output ${formatCompact(usage.outputTokens)}`);
    if (typeof usage.thoughtTokens === 'number') parts.push(`reasoning ${formatCompact(usage.thoughtTokens)}`);
    if (typeof usage.cachedReadTokens === 'number') parts.push(`cache read ${formatCompact(usage.cachedReadTokens)}`);
    if (typeof usage.cachedWriteTokens === 'number') parts.push(`cache write ${formatCompact(usage.cachedWriteTokens)}`);
    tokensEl.title = parts.length
      ? `Billed tokens for this turn: ${parts.join(' · ')}`
      : 'Billed tokens for this turn';
  }

  // --- Thoughts ---

  function syncThoughtLayout(thought) {
    if (initialRender) {
      initialRender.thoughts.add(thought);
      return;
    }
    syncThoughtLayouts([thought]);
  }

  function measureThoughtLayout(thought) {
    if (!thought || !thoughtMeasure) return null;
    const text = thought.text.trim();
    const singleLine = text && !/[\r\n]/.test(text);
    // Multiline thoughts never use compact mode, even while hidden. No geometry
    // is needed. Hidden single-line thoughts are measured by ResizeObserver on
    // expansion, when their actual available width becomes known.
    if (!singleLine) return { thought, compact: false, label: text };
    if (isLayoutHidden(thought.details)) return null;
    const width = thought.details.clientWidth;
    if (!width) return null;
    const heading = singleLine && /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(text);
    const bold = singleLine && /^(?:\*\*([^*]+)\*\*|__([^_]+)__)$/.exec(text);
    const label = heading?.[1] || bold?.[1] || bold?.[2] || text;
    thoughtMeasure.font = getComputedStyle(thought.body).font;
    return { thought, compact: thoughtMeasure.measureText(label).width <= width - 16, label };
  }

  function applyThoughtLayout({ thought, compact, label }) {
    if (compact !== thought.compact) {
      if (compact) thought.expanded = thought.details.open;
      thought.details.open = compact || thought.expanded;
      thought.details.classList.toggle('compact', compact);
      thought.compact = compact;
    }
    const text = compact ? label : thought.text;
    if (thought.body.textContent !== text) thought.body.textContent = text;
  }

  function syncThoughtLayouts(thoughts) {
    // All geometry reads precede all DOM writes, including resize notifications
    // for many thoughts revealed together. Never alternate layout and mutation.
    const layouts = thoughts.map(measureThoughtLayout).filter(Boolean);
    for (const layout of layouts) applyThoughtLayout(layout);
  }

  function createThought(messageId, turnId) {
    finalizeAssistant();
    const details = document.createElement('details');
    details.className = 'thought streaming';
    details.open = false;
    const summary = document.createElement('summary');
    const labelEl = el('span', 'thought-label kind', 'Thinking…');
    const tokensEl = el('span', 'tokens', '');
    summary.appendChild(labelEl);
    summary.appendChild(tokensEl);
    const body = el('div', 'body');
    details.appendChild(summary);
    details.appendChild(body);
    beginIntermediate(turnId).body.appendChild(details);
    syncTurnSteps();
    const thought = {
      messageId: messageId || null,
      details,
      summary,
      labelEl,
      tokensEl,
      body,
      text: '',
      tokens: 0,
      compact: false,
      expanded: false,
    };
    currentThought = thought;
    thoughtLayouts.set(details, thought);
    thoughtResize?.observe(details);
    return thought;
  }

  function appendThoughtChunk(text, messageId, turnId) {
    finalizeToolGroup();
    hideEmpty();
    let thought = currentThought;
    if (thought && messageId && thought.messageId && messageId !== thought.messageId) {
      finalizeThought();
      thought = null;
    }
    if (!thought) thought = createThought(messageId, turnId);
    thought.text += text;
    thought.body.textContent = thought.text;
    syncThoughtLayout(thought);
    thought.tokens = estimateTokens(thought.text);
    thought.tokensEl.textContent = formatTokens(thought.tokens);
    thought.tokensEl.title = 'Estimated from streamed content';
    thought.details.dataset.tokens = String(thought.tokens);
    syncTurnSteps();
  }

  function finalizeThought(thought = currentThought) {
    if (!thought) return;
    thought.details.classList.remove('streaming');
    if (!initialRender && !canFold(thought.details)) deferFold(thought.details, thought.compact);
    else thought.details.open = thought.compact;
    thought.expanded = false;
    thought.labelEl.textContent = 'Thoughts';
    syncThoughtLayout(thought);
    if (currentThought === thought) currentThought = null;
  }

  // --- User & Assistant Messages ---

  function addUserImages(wrap, images, messageId) {
    if (!Array.isArray(images) || !images.length) return;
    const gallery = el('div', 'user-images');
    for (const image of images) {
      const figure = el('figure');
      const thumb = el('img');
      thumb.src = image.dataUrl;
      thumb.alt = image.name || 'image';
      thumb.addEventListener('load', () => onAsyncLayout?.());
      figure.appendChild(thumb);
      artifacts.offer(
        {
          id: `image-${++store.state.artifactSeq}`,
          title: image.name || 'Image',
          kind: 'image',
          dataUrl: image.dataUrl,
          origin: { messageId },
        },
        figure
      );
      gallery.appendChild(figure);
    }
    wrap.appendChild(gallery);
  }

  function renderUserMessage(text, messageId, images, timestamp) {
    finalizeThought();
    finalizeAssistant();
    finalizeToolGroup();
    finalizeTurnSteps();
    hideEmpty();

    if (messageId && lastUser && lastUser.messageId === messageId) {
      lastUser.text += text;
      const visible = richText.visiblePrompt(lastUser.text);
      lastUser.body.textContent = visible;
      lastUser.body.hidden = !visible;
      if (stickyPrompt) stickyPrompt.querySelector('button').textContent = visible || 'Latest prompt';
      addUserImages(lastUser.wrap, images, messageId);
      return;
    }

    const wrap = el('div', 'message user');
    assignAcpAnchor(wrap, 'user');
    const visible = richText.visiblePrompt(text);
    const body = el('div', 'body', visible);
    body.hidden = !visible;
    wrap.appendChild(body);
    addUserImages(wrap, images, messageId);
    stampMessage(wrap, messageId, timestamp);
    messagesEl.appendChild(wrap);
    lastUser = { messageId: messageId || null, wrap, body, text };
    updateStickyPrompt();
  }

  function createAssistant(messageId) {
    const wrap = el('div', 'message assistant');
    wrap.hidden = true;
    assignAcpAnchor(wrap, 'assistant');
    const body = el('div', 'body');
    wrap.appendChild(body);
    stampMessage(wrap, messageId);
    messagesEl.appendChild(wrap);
    const assistant = { messageId: messageId || null, wrap, body, text: '', finalized: false };
    currentAssistant = assistant;
    return assistant;
  }

  function appendAssistantChunk(text, messageId) {
    if (currentThought) finalizeThought();
    finalizeToolGroup();
    hideEmpty();

    let assistant = currentAssistant;
    if (
      !assistant ||
      assistant.finalized ||
      (messageId && assistant.messageId && messageId !== assistant.messageId)
    ) {
      if (assistant) finalizeAssistant();
      assistant = createAssistant(messageId);
    }
    assistant.text += text;
    return assistant;
  }

  function finalizeAssistant() {
    const assistant = currentAssistant;
    if (!assistant) return false;
    assistant.finalized = true;
    let hadVisibleText = false;
    if (!assistant.text.trim()) {
      assistant.wrap.remove();
    } else {
      hadVisibleText = true;
      assistant.wrap.hidden = false;
      assistant.body.classList.add('md');
      assistant.body.innerHTML = renderMarkdown(assistant.text);
      richText.outline(assistant.body);
      richText.hydrate(assistant.body, () => onAsyncLayout?.());
      artifacts.ingest(assistant.body);
      for (const block of assistant.body.querySelectorAll('.diagram')) {
        artifacts.offer(
          {
            id: `diagram-${++store.state.artifactSeq}`,
            title: 'Diagram',
            kind: 'mermaid',
            content: block.querySelector('.visual-source-panel code').textContent,
            origin: { messageId: assistant.messageId },
          },
          block
        );
      }
      scheduleFileChecks();
      // The reducer owns turn state: this may be an earlier answer being
      // rendered after the entire history snapshot has already been reduced.
      finalizeTurnSteps();
    }
    currentAssistant = null;
    return hadVisibleText;
  }

  // --- Tool Groups, Cards, Standalone Splits & Progress/Background Overlays ---

  function createToolGroupBlock(background = false, turnId = '') {
    const details = document.createElement('details');
    details.className = 'tool-group';
    details.open = false;
    const summary = document.createElement('summary');
    const kindEl = el('span', 'kind', 'Tool');
    const nameEl = el('span', 'name', '');
    const tokensEl = el('span', 'tokens', '');
    const statusEl = el('span', 'status', '');
    summary.appendChild(kindEl);
    summary.appendChild(nameEl);
    summary.appendChild(tokensEl);
    summary.appendChild(statusEl);
    const body = el('div', 'body');
    details.appendChild(summary);
    details.appendChild(body);
    const liveTail = Boolean(turnSteps && turnSteps.details.classList.contains('live'));
    if (background && !liveTail) {
      finalizeToolGroup();
      finalizeTurnSteps();
      assignAcpAnchor(details, 'tool');
      messagesEl.appendChild(details);
    } else {
      // Inside the streaming tail a background command keeps the ordinary
      // template: it neither folds the rows before it nor splits the rows
      // after it. It is lifted out only once Steps actually collapse.
      beginIntermediate(turnId).body.appendChild(details);
    }
    details.dataset.turn = turnId || store.state.turnId || '';
    const group = { details, kindEl, nameEl, tokensEl, statusEl, body, cards: [] };
    toolGroup = group;
    syncTurnSteps();
    return group;
  }

  function syncToolGroup(group) {
    if (!group || group.cards.length === 0) return;
    if (initialRender) {
      initialRender.groups.add(group);
      return;
    }
    const count = group.cards.length;
    if (count === 1) {
      const summary = summarizeTools(group.cards, store.state.cwd || '');
      group.kindEl.textContent = summary.metrics.length === 1 ? summary.metrics[0] : summary.label;
      const name = group.cards[0].nameEl.textContent || '';
      group.nameEl.classList.remove('step-metrics');
      group.nameEl.textContent = /^(other|tool)$/i.test(name) ? '' : name;
    } else {
      renderStepSummary(group.kindEl, group.nameEl, group.cards);
    }
    group.details.classList.toggle('single', count === 1);

    const statuses = group.cards.map((card) => card.statusValue).filter(Boolean);
    let status = '';
    if (statuses.includes('in_progress')) status = 'in_progress';
    else if (statuses.includes('pending')) status = 'pending';
    else if (statuses.includes('failed')) status = 'failed';
    else if (statuses.includes('cancelled')) status = 'cancelled';
    else if (statuses.length > 0 && statuses.every((value) => value === 'completed')) {
      status = 'completed';
    }
    group.statusEl.textContent = status ? toolStatusLabel(status) : '';
    group.statusEl.className = 'status' + (status ? ' ' + status : '');
    const totalTokens = group.cards.reduce((sum, card) => sum + (card.tokens || 0), 0);
    group.tokensEl.textContent = formatTokens(totalTokens);
    group.tokensEl.title = totalTokens ? 'Estimated tokens for these operations' : '';
    group.details.dataset.tokens = String(totalTokens);
    for (const card of group.cards) if (card.background) syncBackgroundCard(card);
    for (const card of group.cards) syncCommandProgress(card);
  }

  function finalizeToolGroup() {
    if (!toolGroup) return;
    syncToolGroup(toolGroup);
    toolGroup = null;
  }

  function refreshStepBlock(block) {
    const body = block.querySelector('.body');
    if (!body.children.length) {
      block.remove();
      return;
    }
    block.removeAttribute('data-exact');
    renderStepSummary(
      block.querySelector('summary > .kind'),
      block.querySelector('summary > .name'),
      turnToolCards(block),
      countBlockSteps(block)
    );
    const tokens = [...body.children].reduce((sum, child) => sum + Number(child.dataset.tokens || 0), 0);
    block.querySelector('summary > .tokens').textContent = tokens ? formatTokens(tokens) : '';
  }

  function settleStandaloneTasks(block) {
    if (!block || !messagesEl.contains(block) || block.classList.contains('live')) return;
    for (const entry of block.querySelectorAll('.tool-entry')) {
      const card = toolCards.get(entry.dataset.toolCallId);
      if (card && (card.background || card.progressVisible)) {
        separateStandalone(card, Boolean(card.background));
      }
    }
  }

  function separateStandalone(card, whenSettled = false) {
    const group = card.group.details;
    const block = group.closest?.('.turn-steps');
    if (!block) return;
    // A background command that belongs to the streaming tail stays inline
    // with the rows around it; `whenSettled` lifts it out of folded Steps only.
    if (whenSettled && block.classList.contains('live')) return;
    group.dataset.turn = block.dataset.turn;
    assignAcpAnchor(group, 'standalone');
    let after;
    if (group.nextSibling) {
      after = block.cloneNode(false);
      after.removeAttribute('data-exact');
      after.removeAttribute('data-anchor-id');
      assignAcpAnchor(after, 'steps-tail');
      after.appendChild(block.querySelector('summary').cloneNode(true));
      const remainder = el('div', 'body');
      while (group.nextSibling) remainder.appendChild(group.nextSibling);
      after.appendChild(remainder);
    }
    block.after(group);
    if (after) group.after(after);
    if (turnSteps?.details === block) {
      turnSteps = after
        ? {
            details: after,
            body: after.querySelector('.body'),
            titleEl: after.querySelector('summary > .kind'),
            metaEl: after.querySelector('summary > .name'),
            tokensEl: after.querySelector('summary > .tokens'),
          }
        : null;
    }
    for (const item of [block, after].filter(Boolean)) refreshStepBlock(item);
  }

  function restoreStandaloneSteps(card, statusChanged) {
    const group = card.group.details;
    const enclosing = group.closest?.('.turn-steps');
    if (enclosing) {
      if (statusChanged) refreshStepBlock(enclosing);
      return;
    }
    const turn = group.dataset.turn;
    const adjacent = (node) =>
      node?.classList?.contains('turn-steps') && node.dataset.turn === turn ? node : null;
    const previous = adjacent(group.previousElementSibling);
    const next = adjacent(group.nextElementSibling);
    const block = previous || next || createTurnStepsBlock(turn, group).details;
    const body = block.querySelector('.body');
    const open = block.open || group.open || Boolean(next?.open);
    if (previous) {
      body.appendChild(group);
      if (next) {
        body.append(...next.querySelector('.body').childNodes);
        next.remove();
      }
    } else if (next) {
      body.prepend(group);
    } else {
      if (group.dataset.anchorId) {
        block.dataset.anchorId = group.dataset.anchorId;
        delete group.dataset.anchorId;
      }
      body.appendChild(group);
    }
    block.open = open;
    if (
      turnSteps?.details === previous ||
      turnSteps?.details === next ||
      (!store.state.turnEnded && turn === store.state.turnId && block === messagesEl.lastElementChild)
    ) {
      turnSteps = {
        details: block,
        body,
        titleEl: block.querySelector('summary > .kind'),
        metaEl: block.querySelector('summary > .name'),
        tokensEl: block.querySelector('summary > .tokens'),
      };
      setStepsLive(block, true);
    }
    refreshStepBlock(block);
  }

  function syncCommandProgress(card) {
    const value = store.state.commandProgress.get(card.entry.dataset.toolCallId);
    const active = card.background || ['pending', 'in_progress'].includes(card.statusValue);
    const visible =
      active &&
      value &&
      Number.isSafeInteger(value.completed) &&
      Number.isSafeInteger(value.total) &&
      value.total > 0 &&
      value.completed >= 0 &&
      value.completed <= value.total;
    const changed = Boolean(card.progressVisible) !== Boolean(visible);
    card.progressVisible = Boolean(visible);
    const group = card.group;
    const wasStandalone = group.details.classList.contains('standalone-task');
    if (visible && !group.progressEl) {
      group.progressEl = el('span', 'command-progress');
      group.progressTrack = el('span', 'command-progress-track');
      group.progressTrack.setAttribute('role', 'progressbar');
      group.progressFill = el('span', 'command-progress-fill');
      group.progressCount = el('span', 'command-progress-count');
      group.progressCount.setAttribute('aria-hidden', 'true');
      group.progressTrack.appendChild(group.progressFill);
      group.progressEl.append(group.progressTrack, group.progressCount);
      group.details.querySelector('summary').insertBefore(group.progressEl, group.tokensEl);
    }
    if (group.progressEl) group.progressEl.hidden = !visible;
    group.nameEl.hidden = Boolean(visible);
    group.details.classList.toggle('progress-task', Boolean(visible));
    group.details.classList.toggle('background-task', Boolean(card.background));
    group.details.classList.toggle('standalone-task', Boolean(card.background || visible));
    if (visible) {
      const count = `${value.completed.toLocaleString('en-US')} / ${value.total.toLocaleString('en-US')}`;
      group.progressTrack.setAttribute('aria-label', value.label || 'Command progress');
      group.progressTrack.setAttribute('aria-valuemin', '0');
      group.progressTrack.setAttribute('aria-valuemax', String(value.total));
      group.progressTrack.setAttribute('aria-valuenow', String(value.completed));
      group.progressTrack.setAttribute('aria-valuetext', count);
      group.progressFill.style.width = `${(value.completed / value.total) * 100}%`;
      group.progressCount.textContent = count;
      group.progressEl.title = `${value.label || 'Command progress'}: ${count}`;
    }
    if (card.background || visible) separateStandalone(card, Boolean(card.background));
    else if (wasStandalone) restoreStandaloneSteps(card, changed);
  }

  function syncBackgroundCard(card) {
    const run = store.state.backgroundRuns.get(card.entry.dataset.toolCallId);
    if (!card.background && !run && !card.activity.background && !card.activity.rawInput?.background) {
      return;
    }
    const status = run?.status || (card.activity.status === 'failed' ? 'failed' : 'unknown');
    const finished = !['unknown', 'running', 'stopping'].includes(status);
    card.background = !finished;
    if (!finished) separateStandalone(card, true);
    if (!finished && !card.stopBackground) {
      const button = el('button', 'btn danger icon-btn background-stop');
      button.type = 'button';
      button.setAttribute('aria-label', 'Stop background task');
      button.title = 'Stop background task';
      button.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.4"/></svg>';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.stopError = '';
        const current = store.state.backgroundRuns.get(card.entry.dataset.toolCallId);
        if (!current || current.status !== 'running') return;
        current.status = 'stopping';
        syncBackgroundCard(card);
        postMessage({ type: 'stopBackground', toolCallId: card.entry.dataset.toolCallId });
      });
      card.group.details.querySelector('summary').appendChild(button);
      card.stopBackground = button;
      card.backgroundError = el('div', 'background-error');
      card.backgroundError.setAttribute('role', 'alert');
      card.group.body.appendChild(card.backgroundError);
    }
    if (card.stopBackground) {
      card.stopBackground.hidden = !['running', 'stopping'].includes(status);
      card.stopBackground.disabled = status === 'stopping';
      card.stopBackground.title = status === 'stopping' ? 'Stopping…' : 'Stop background task';
      card.backgroundError.textContent = card.stopError || run?.error || '';
      card.backgroundError.hidden = !card.backgroundError.textContent;
    }
    if (typeof run?.output === 'string' && card.rows.output) {
      const text = run.output + (run.truncated ? '\n… Output truncated' : '');
      if (card.rows.output.contentEl.textContent !== text) {
        card.rows.output.contentEl.replaceChildren();
        setToolPre(card.rows.output, text);
        card.backgroundOutput = text;
      }
      card.body.hidden = false;
    }
    if (finished) {
      const previousStatus = card.statusValue;
      card.statusValue =
        status === 'exited'
          ? run.exit === 0
            ? 'completed'
            : 'failed'
          : ['stopped', 'killed'].includes(status)
            ? 'cancelled'
            : status === 'unavailable'
              ? 'unknown'
              : 'failed';
      card.statusEl.textContent = toolStatusLabel(card.statusValue);
      card.statusEl.className = 'status ' + card.statusValue;
      delete card.group.statusEl.dataset.running;
      syncToolGroup(card.group);
      if (status === 'unavailable') card.group.statusEl.textContent = 'unavailable';
      restoreStandaloneSteps(card, previousStatus !== card.statusValue);
    } else {
      card.group.statusEl.textContent = status === 'unknown' ? 'pending' : 'in background';
      card.group.statusEl.className = 'status background-state';
      card.group.statusEl.dataset.running = String(status !== 'unknown');
      syncBackgroundPulse();
    }
    syncCommandProgress(card);
  }

  function createToolCard(update, turnId) {
    const subagent = isSubagentTool(update);
    const group = createToolGroupBlock(Boolean(update.background || update.rawInput?.background), turnId);
    const entry = el('div', subagent ? 'tool-entry subagent-entry' : 'tool-entry');
    entry.dataset.toolCallId = update.toolCallId;
    const header = el('div', 'tool-entry-header');
    const kindEl = el('span', 'kind', subagent ? 'sub-agent' : update.kind || 'tool');
    const labelText = subagent ? subagentLabel(update) : update.title || update.kind || 'tool';
    const nameEl = el('span', 'name', labelText);
    const tokensEl = el('span', 'tokens', '');
    const statusEl = el('span', 'status', '');
    header.appendChild(kindEl);
    header.appendChild(nameEl);
    header.appendChild(tokensEl);
    header.appendChild(statusEl);
    const body = el('div', 'body');
    body.hidden = true;
    entry.appendChild(header);
    entry.appendChild(body);
    group.body.appendChild(entry);

    const card = {
      group,
      entry,
      kindEl,
      nameEl,
      tokensEl,
      statusEl,
      body,
      subagent,
      kind: subagent ? 'sub-agent' : update.kind || 'tool',
      labelText,
      statusValue: null,
      activity: update,
      tokens: 0,
      inputText: '',
      outputText: '',
      rows: subagent
        ? {}
        : {
            input: createToolRow(body, 'IN'),
            output: createToolRow(body, 'OUT'),
            files: createToolRow(body, 'FILES'),
          },
    };
    group.cards.push(card);
    toolCards.set(update.toolCallId, card);
    permissionsView.reattachForTool(card);
    syncToolGroup(group);
    syncTurnSteps();
    return card;
  }

  function renderLocations(card, locations) {
    const row = card.rows.files;
    if (!row || !Array.isArray(locations) || locations.length === 0) return;
    let list = row.contentEl.querySelector('ul');
    if (!list) {
      list = el('ul', 'locations');
      row.contentEl.appendChild(list);
    }
    list.replaceChildren();
    for (const location of locations) {
      if (location && location.path) {
        const line = Number(location.line) || null;
        const label = line ? `${location.path}:${line}` : location.path;
        const item = el('li');
        const link = el('span', 'file-ref', label);
        link.title = label;
        link.dataset.file = location.path;
        if (line) link.dataset.line = String(line);
        item.appendChild(link);
        list.appendChild(item);
      }
    }
    row.row.hidden = list.children.length === 0;
    scheduleFileChecks();
  }

  function renderToolContent(card, update) {
    const input = toolInputText(update);
    if (input && card.rows.input) {
      card.inputText = input;
      setToolPre(card.rows.input, input);
    }
    if (card.rows.output && (Array.isArray(update.content) || update.rawOutput !== undefined)) {
      card.outputText = toolContentText(update);
      card.rows.output.row.hidden = !richText.renderToolResult(
        card.rows.output.contentEl,
        update,
        postMessage
      );
      const diffItems = (update.content || []).filter(
        (item) => item?.type === 'diff' && typeof item.newText === 'string'
      );
      for (const [index, block] of [...card.rows.output.contentEl.querySelectorAll('.tool-diff')].entries()) {
        artifacts.offer(
          {
            ...diffItems[index],
            id: `diff-${++store.state.artifactSeq}`,
            title: diffItems[index].path || 'Diff',
            kind: 'diff',
            origin: { toolCallId: update.toolCallId },
          },
          block
        );
      }
      for (const block of card.rows.output.contentEl.querySelectorAll('.tool-image')) {
        artifacts.offer(
          {
            id: `image-${++store.state.artifactSeq}`,
            title: 'Tool image',
            kind: 'image',
            dataUrl: block.querySelector('img').src,
            origin: { toolCallId: update.toolCallId },
          },
          block
        );
      }
    }
    card.tokens = estimateTokens(card.inputText) + estimateTokens(card.outputText);
    card.tokensEl.textContent = formatTokens(card.tokens);
    card.tokensEl.title = card.tokens ? 'Estimated tokens for this operation' : '';
    card.entry.dataset.tokens = String(card.tokens);
  }

  function showToolActivity(card) {
    const update = card.activity;
    store.state.liveToolId = update.toolCallId;
    card.labelText = card.nameEl.textContent;
    const { kind, text, summary } = describeToolAction(card);
    if (summary && store.state.busy) store.state.activityPurpose = summary;
    store.setLiveAction(kind, text, update.toolCallId, summary, `tool:${update.toolCallId}`, card.startedAt);
  }

  function upsertTool(update, turnId) {
    if (!update || !update.toolCallId) return;
    let card = toolCards.get(update.toolCallId);
    if (!card) {
      finalizeAssistant();
      finalizeThought();
      hideEmpty();
      card = createToolCard(update, turnId);
      card.activityTurn = turnId || store.state.turnId;
    }
    card.activity = { ...card.activity, ...update };
    if (card.startedAt === undefined) card.startedAt = Date.now();
    if (card.subagent) {
      const label = subagentLabel(update);
      if (label) {
        card.nameEl.textContent = label;
        card.labelText = label;
      }
    } else {
      if (update.kind) {
        card.kind = update.kind;
        card.kindEl.textContent = update.kind;
      }
      if (update.title) {
        card.nameEl.textContent = update.title;
        card.labelText = update.title;
      }
    }
    if (update.status) {
      card.statusValue = update.status;
      card.statusEl.textContent = toolStatusLabel(update.status);
      card.statusEl.className = 'status ' + update.status;
    }
    renderLocations(card, update.locations);
    renderToolContent(card, update);
    permissionsView.restorePermissionRejection(card);
    if (!card.subagent) {
      card.body.hidden = !Object.values(card.rows).some((row) => !row.row.hidden);
    }
    syncToolGroup(card.group);
    syncBackgroundCard(card);
    syncCommandProgress(card);
    syncTurnSteps();
    if (!card.background && (card.statusValue === 'pending' || card.statusValue === 'in_progress')) {
      showToolActivity(card);
    } else if (store.state.liveToolId === update.toolCallId) {
      const running = [...toolCards.values()]
        .reverse()
        .find(
          (item) =>
            !item.background &&
            item.activityTurn === store.state.turnId &&
            (item.statusValue === 'pending' || item.statusValue === 'in_progress')
        );
      if (running) showToolActivity(running);
      else store.clearLiveAction();
    }
  }

  // --- Inline Plan ---

  function renderPlan(planEntries, turnId) {
    hideEmpty();
    finalizeAssistant();
    finalizeThought();
    finalizeToolGroup();
    const container = beginIntermediate(turnId).body;
    const isLast =
      planEl && planEl.container === container && container.lastElementChild === planEl.details;
    if (!isLast) {
      const details = document.createElement('details');
      details.className = 'plan';
      details.open = false;
      const summary = el('summary', 'plan-title');
      summary.appendChild(el('span', 'plan-label kind', 'Plan'));
      const tokensEl = el('span', 'tokens', '');
      summary.appendChild(tokensEl);
      const entries = el('div', 'plan-entries');
      details.appendChild(summary);
      details.appendChild(entries);
      container.appendChild(details);
      planEl = { details, entries, container, tokensEl };
    }
    planEl.entries.replaceChildren();
    if (planProgressEl) {
      const done = planEntries.filter((entry) => entry.status === 'completed').length;
      const current =
        planEntries.find((entry) => entry.status === 'in_progress') ||
        planEntries.find((entry) => entry.status !== 'completed');
      planProgressEl.hidden = !planEntries.length;
      const meter = document.getElementById('plan-meter');
      meter.max = planEntries.length || 1;
      meter.value = done;
      const text = `${done}/${planEntries.length} · ${current?.content || 'Plan complete'}`;
      document.getElementById('plan-progress-text').textContent = text;
      planProgressEl.title = text;
    }
    for (const entry of planEntries) {
      const row = el('div', 'plan-entry ' + (entry.status || 'pending'));
      const marker =
        entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◐' : '○';
      row.appendChild(el('span', 'marker', marker));
      row.appendChild(el('span', null, entry.content || ''));
      planEl.entries.appendChild(row);
    }
    const planTokens = estimateTokens(planEntries.map((entry) => entry.content || '').join(' '));
    planEl.tokensEl.textContent = formatTokens(planTokens);
    planEl.tokensEl.title = planTokens ? 'Estimated tokens for the plan' : '';
    planEl.details.dataset.tokens = String(planTokens);
    syncTurnSteps();
  }

  // --- Queued / Pending Submissions & Delivery Badges ---

  function setInputStatus(wrap, status) {
    let label = wrap.querySelector('.delivery-status');
    if (!label) {
      label = el('span', 'delivery-status');
      label.id = `delivery-${wrap.dataset.messageId}`;
      label.setAttribute('role', 'status');
      label.setAttribute('aria-atomic', 'true');
      wrap.appendChild(label);
    }
    wrap.dataset.delivery = status;
    const text = INPUT_STATUS_LABELS[status] || status;
    if (label.textContent !== text) label.textContent = text;
    const id = wrap.dataset.messageId;
    const canResend =
      ['unknown', 'failed', 'cancelled'].includes(status) &&
      store.state.submissions.get(id)?.item;
    wrap.title = canResend
      ? 'Message undelivered — click icon to resend.'
      : status === 'unknown'
        ? 'Message undelivered.'
        : text;
    for (const content of wrap.querySelectorAll('.body, .user-images')) {
      content.setAttribute('aria-describedby', label.id);
    }
    const body = wrap.querySelector('.body');
    const target = body?.textContent ? body : wrap.querySelector('.user-images');
    const kind = canResend ? 'resend' : status === 'queued' ? 'queued' : null;
    let indicator = wrap.querySelector('.delivery-indicator');
    if (indicator && (indicator.dataset.kind !== kind || indicator.parentElement !== target)) {
      indicator.parentElement.classList.remove('has-delivery-indicator');
      indicator.remove();
      indicator = null;
    }
    if (kind && target && !indicator) {
      indicator = el(canResend ? 'button' : 'span', 'delivery-indicator');
      indicator.dataset.kind = kind;
      indicator.title = wrap.title;
      indicator.setAttribute('aria-label', canResend ? 'Resend message' : 'Queued');
      if (canResend) {
        indicator.type = 'button';
        indicator.addEventListener('click', () => onResendSubmission?.(id));
      } else {
        indicator.setAttribute('role', 'img');
      }
      indicator.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        (canResend
          ? '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7"/>'
          : '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>') +
        '</svg>';
      target.classList.add('has-delivery-indicator');
      target.appendChild(indicator);
    }
  }

  function renderSubmission(entry) {
    if (nativeUsers.has(entry.id)) return;
    let nodeRecord = submissionNodes.get(entry.id);
    if (!nodeRecord) {
      if (!entry.item) return;
      hideEmpty();
      const wrap = el('div', 'message user queued-input');
      wrap.dataset.anchorId = entry.id;
      wrap.dataset.messageId = entry.id;
      const payload = entry.item?.payload || {};
      wrap.appendChild(el('div', 'body', richText.visiblePrompt(payload.text || '')));
      const images = (payload.files || []).flatMap((file) => {
        const uri =
          file.uri ||
          (/^image\/(png|jpeg|gif|webp)$/.test(file.mime || '') && typeof file.data === 'string'
            ? `data:${file.mime};base64,${file.data}`
            : '');
        return /^data:image\/(png|jpeg|gif|webp);base64,/.test(uri)
          ? [{ dataUrl: uri, name: file.name }]
          : [];
      });
      addUserImages(wrap, images, entry.id);
      stampMessage(wrap, entry.id, entry.item?.time?.created);
      messagesEl.appendChild(wrap);
      nodeRecord = { wrap };
      submissionNodes.set(entry.id, nodeRecord);
    }
    setInputStatus(nodeRecord.wrap, entry.state);
    if (entry.error) nodeRecord.wrap.dataset.deliveryError = entry.error;
  }

  function placeSubmissions() {
    const created = (id, nodeRecord) =>
      store.state.submissions.get(id)?.item?.time?.created ||
      Number(nodeRecord.wrap.querySelector('.message-time')?.dataset?.timestamp) ||
      Infinity;
    const users = [...nativeUsers].map(([id, wrap]) => ({
      wrap,
      time: store.state.messageTimes.get(id),
    }));
    const sorted = [...submissionNodes.entries()].sort(
      ([idA, a], [idB, b]) => created(idA, a) - created(idB, b)
    );
    for (const [id, nodeRecord] of sorted) {
      const entryTime = created(id, nodeRecord);
      const next = users.find((user) => user.time > entryTime);
      messagesEl.insertBefore(nodeRecord.wrap, next?.wrap || null);
    }
    updateStickyPrompt();
  }

  // --- Notices ---

  function renderInfo(text) {
    if (!text) return;
    finalizeToolGroup();
    hideEmpty();
    const target = turnSteps ? turnSteps.body : messagesEl;
    const node = el('div', 'info', text);
    if (!turnSteps) assignAcpAnchor(node, 'info');
    target.appendChild(node);
    if (turnSteps) syncTurnSteps();
  }

  function renderError(text) {
    if (!text) return;
    finalizeThought();
    finalizeAssistant();
    finalizeToolGroup();
    settleLiveSteps();
    hideEmpty();
    const node = el('div', 'error', text);
    assignAcpAnchor(node, 'error');
    messagesEl.appendChild(node);
  }

  // --- Bottom Disclosure Collapse Controls ---

  function addCollapseControl(details) {
    if (details.closest?.('.result-tree')) return;
    if (details.matches?.('.turn-steps.live')) return;
    if (!details.open || !details.querySelector(':scope > summary')) return;
    let button = details.querySelector(':scope > .disclosure-collapse');
    if (!button) {
      button = el('button', 'disclosure-collapse', 'Collapse');
      button.type = 'button';
      button.addEventListener('click', () => {
        const summary = details.querySelector(':scope > summary');
        const top = summary.getBoundingClientRect().top;
        details.open = false;
        focusLocal(summary);
        if (top < messagesEl.getBoundingClientRect().top) {
          richText.scrollToElement(messagesEl, summary, { behavior: 'instant' });
        }
      });
    }
    if (details.lastElementChild !== button) details.appendChild(button);
  }

  document.addEventListener('toggle', (event) => {
    if (typeof HTMLDetailsElement !== 'undefined' && event.target instanceof HTMLDetailsElement) {
      addCollapseControl(event.target);
    }
  }, true);

  new window.MutationObserver(() => {
    for (const details of document.querySelectorAll('details[open]')) {
      addCollapseControl(details);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Plan progress header click -> expand & navigate to latest inline plan
  planProgressEl?.addEventListener('click', () => {
    const plan = planEl?.details;
    if (!plan) return;
    for (let parent = plan; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    const summary = plan.querySelector('summary');
    richText.scrollToElement(messagesEl, summary);
    focusLocal(summary);
  });

  // --- Main Reconciler Loop ---

  function resetDom() {
    thoughtResize?.disconnect();
    if (planProgressEl) planProgressEl.hidden = true;
    artifacts.reset();
    currentAssistant = null;
    currentThought = null;
    lastUser = null;
    toolGroup = null;
    turnSteps = null;
    planEl = null;
    stickyPrompt = null;
    stickyTarget = null;
    toolCards.clear();
    nativeAssistants.clear();
    nativeThoughts.clear();
    nativeUsers.clear();
    submissionNodes.clear();
    pendingFolds.clear();
    messagesEl.replaceChildren(emptyEl);
    hideEmpty();
    permissionsView.resetForReplay();
  }

  function executeOp(op) {
    switch (op.type) {
      case 'resetTranscript':
        resetDom();
        break;
      case 'beginNativeMessage':
        activeNativeMessageId = op.messageId;
        nativeBeforeChildren = new Set(messagesEl.children);
        break;
      case 'endNativeMessage': {
        if (nativeBeforeChildren && op.messageId) {
          let index = 0;
          for (const node of messagesEl.children) {
            if (!nativeBeforeChildren.has(node) && !node.dataset.anchorId) {
              node.dataset.anchorId = `${op.messageId}:${index++}`;
            }
          }
        }
        activeNativeMessageId = null;
        nativeBeforeChildren = null;
        break;
      }
      case 'userMessage':
        renderUserMessage(op.text, op.messageId, op.images, op.timestamp);
        break;
      case 'markDeliveredUser':
        submissionNodes.get(op.messageId)?.wrap.remove();
        submissionNodes.delete(op.messageId);
        if (lastUser) nativeUsers.set(op.messageId, lastUser.wrap);
        break;
      case 'assistantChunk':
        appendAssistantChunk(op.text, op.messageId);
        break;
      case 'nativeAssistantText': {
        let record = nativeAssistants.get(op.key);
        if (!record) {
          record = appendAssistantChunk(op.text, op.key);
          nativeAssistants.set(op.key, record);
        }
        // A completed new answer is rendered by finalizeAssistant below. Do not
        // parse its Markdown twice during history restoration.
        const completingCurrent = op.newlyCompleted && !record.nativeComplete && currentAssistant === record;
        if (record.text !== op.text || record.wrap.hidden) {
          record.text = op.text;
          if (!completingCurrent) {
            record.wrap.hidden = false;
            record.body.classList.add('md');
            record.body.innerHTML = renderMarkdown(record.text);
          }
        }
        stampMessage(record.wrap, op.messageId, op.timestamp);
        if (op.newlyCompleted && !record.nativeComplete) {
          record.nativeComplete = true;
          if (currentAssistant === record) {
            finalizeAssistant();
          } else {
            richText.hydrate(record.body, () => onAsyncLayout?.());
            artifacts.ingest(record.body);
          }
        }
        break;
      }
      case 'thoughtChunk':
        appendThoughtChunk(op.text, op.messageId, op.turnId);
        break;
      case 'nativeThought': {
        const { text, completed } = op.block;
        let record = nativeThoughts.get(op.key);
        if (!record) {
          appendThoughtChunk(text, op.key, op.turnId);
          record = currentThought;
          nativeThoughts.set(op.key, record);
        } else if (record.text !== text) {
          record.text = text;
          record.body.textContent = text;
          record.tokens = estimateTokens(record.text);
          record.tokensEl.textContent = formatTokens(record.tokens);
          record.details.dataset.tokens = String(record.tokens);
          syncThoughtLayout(record);
          syncTurnSteps();
        }
        if (completed && !record.nativeComplete) {
          record.nativeComplete = true;
          finalizeThought(record);
        }
        break;
      }
      case 'finalizeStreamed':
        finalizeAssistant();
        finalizeThought();
        break;
      case 'nativeIdle':
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        settleLiveSteps();
        break;
      case 'upsertTool':
        upsertTool(op.update, op.turnId);
        break;
      case 'plan':
        renderPlan(op.entries, op.turnId);
        break;
      case 'syncBackgroundRuns':
        for (const card of toolCards.values()) syncBackgroundCard(card);
        break;
      case 'syncCommandProgress':
        for (const card of toolCards.values()) syncCommandProgress(card);
        break;
      case 'backgroundStopError': {
        const card = toolCards.get(op.toolCallId);
        if (card) {
          card.stopError = op.message;
          syncBackgroundCard(card);
        }
        break;
      }
      case 'upsertSubmission':
        renderSubmission(op.entry);
        break;
      case 'syncNativeDelivery':
        for (const [id, status] of op.states || []) {
          const wrap = nativeUsers.get(id);
          if (wrap) setInputStatus(wrap, status);
        }
        break;
      case 'placeSubmissions':
        placeSubmissions();
        break;
      case 'permission':
        hideEmpty();
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        finalizeTurnSteps();
        permissionsView.renderPermissionCard(op.message, op.attentionKey);
        break;
      case 'permissionRuleResult':
        permissionsView.applyPermissionRuleResult(op.message);
        break;
      case 'smartReview':
        hideEmpty();
        permissionsView.upsertSmartReview(op.review, op.unchanged);
        break;
      case 'clearSmartReviews':
        permissionsView.clearSmartReviews();
        break;
      case 'elicitation':
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        finalizeTurnSteps();
        permissionsView.renderElicitation(op.message, op.attentionKey);
        break;
      case 'requestResolved':
        permissionsView.removeResolvedRequest(op.requestId);
        break;
      case 'syncMessageTimes':
        syncMessageTimes();
        break;
      case 'historyEnd':
        finalizeAssistant();
        if (!store.state.nativeTransport) finalizeThought();
        finalizeToolGroup();
        // Keep any trailing `.turn-steps.live` open: lack of an idle marker in
        // history means the turn is still running on the server.
        break;
      case 'turnEnd': {
        const blocks = op.fresh ? currentTurnBlocks(op.turnId) : [];
        const singleBlock = blocks.length <= 1 ? blocks[0] || null : null;
        const finalizedText = finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        settleLiveSteps();
        if (op.usage && singleBlock) applyBilledUsage(op.usage, singleBlock);
        const hadText = op.hadText || finalizedText;
        if (op.fresh && !hadText) {
          const steps = blocks.reduce((sum, item) => sum + countBlockSteps(item), 0);
          if (steps > 0) {
            renderInfo(`No text answer in this turn — ${steps} step${steps === 1 ? '' : 's'} listed above.`);
          } else {
            renderInfo(noTextAnswer(op.stopReason));
          }
        } else if (op.fresh && op.stopReason === 'cancelled') {
          renderInfo('Stopped by user.');
        }
        break;
      }
      case 'turnStats':
        applyTurnStats(op.turns, op.scope, op.currentTurnId);
        break;
      case 'info':
        renderInfo(op.text);
        break;
      case 'error':
        renderError(op.text);
        break;
      default:
        break;
    }
  }

  function reconcile(ops, { initial = false } = {}) {
    if (!initial || !messagesEl.parentNode) {
      for (const op of ops) executeOp(op);
      return;
    }

    // Keep the container identity (listeners, permission cards and viewport
    // observers), but build the initial snapshot outside the live document.
    // The coordinator's existing begin/endMutation remains the sole scroll
    // transaction. Incremental snapshots never detach an established transcript.
    const placeholder = document.createComment('initial transcript');
    const batch = { thoughts: new Set(), groups: new Set(), steps: new Set(), sticky: false };
    messagesEl.replaceWith(placeholder);
    initialRender = batch;
    try {
      for (const op of ops) executeOp(op);
      initialRender = null;
      // Final counters depend on completed tool contents, not intermediate ops.
      for (const group of batch.groups) {
        if (messagesEl.contains(group.details)) syncToolGroup(group);
      }
      for (const steps of batch.steps) {
        if (messagesEl.contains(steps.details)) syncStepSummary(steps);
      }
      if (batch.sticky) updateStickyPrompt();
    } finally {
      initialRender = null;
      placeholder.replaceWith(messagesEl);
    }
    syncThoughtLayouts([...batch.thoughts]);
  }

  function resolveActionTarget(targetRef) {
    if (!targetRef) return null;
    if (targetRef === 'current-assistant') return currentAssistant?.wrap || null;
    if (targetRef === 'current-thought') return currentThought?.details || null;
    if (String(targetRef).startsWith('tool:')) {
      return toolCards.get(String(targetRef).slice(5))?.entry || null;
    }
    return null;
  }

  return {
    reconcile,
    renderInfo,
    renderError,
    updateStickyVisibility,
    applyPendingFolds,
    getToolCard: (id) => toolCards.get(id) || null,
    resolveActionTarget,
  };
}

module.exports = { createTranscriptRenderer };

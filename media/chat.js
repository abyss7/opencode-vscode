(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const emptyEl = document.getElementById('empty');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const titleEl = document.getElementById('title');
  const subtitleEl = document.getElementById('subtitle');
  const usageEl = document.getElementById('usage');
  const usageCostEl = document.getElementById('usage-cost');
  const usageResetEl = document.getElementById('usage-reset');
  const attachmentsEl = document.getElementById('attachments');
  const configBarEl = document.getElementById('config-bar');
  const slashMenuEl = document.getElementById('slash-menu');
  const subagentsEl = document.getElementById('subagents');
  const subagentsSummaryEl = document.getElementById('subagents-summary');
  const subagentsSummaryTextEl = document.getElementById('subagents-summary-text');
  const subagentsListEl = document.getElementById('subagents-list');

  const STATUS_LABELS = {
    connecting: 'Connecting…',
    ready: 'Ready',
    busy: 'Working…',
    cancelling: 'Stopping…',
    error: 'Error',
  };

  const state = {
    connected: false,
    busy: false,
    statusKind: 'connecting',
    sessionId: null,
    cwd: null,
    currentAssistant: null,
    currentThought: null,
    lastUser: null,
    toolCards: new Map(),
    toolGroup: null,
    turnSteps: null,
    turnSeq: 0,
    turnId: null,
    turnHadText: false,
    turnEnded: false,
    planEl: null,
    usage: null,
    cacheStats: null,
    costSplit: null,
    limits: null,
    budget: null,
    balance: null,
    modelLimit: null,
    subagentCost: 0,
    compaction: null,
    images: [],
    nextImageId: 1,
    imageSupport: false,
    currentAction: null,
    liveToolId: null,
    liveStartedAt: null,
    liveKey: null,
    liveClock: null,
    subagentsRunning: 0,
    autoScroll: true,
    acpCommands: [],
    restCommands: [],
    skills: [],
    slashItems: [],
    slashOpen: false,
    slashIndex: 0,
    userMessageCount: 0,
    commandEchoIndex: -1,
    commandEchoText: '',
    skipUserIndex: -1,
    skipUserId: null,
    replaySeen: new Set(),
    fileChecks: new Map(),
    fileCheckPending: new Set(),
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function shortId(id) {
    if (!id) return '';
    return id.length > 16 ? id.slice(0, 14) + '…' : id;
  }

  function hideEmpty() {
    emptyEl.hidden = true;
  }

  function resetTranscript() {
    state.currentAssistant = null;
    state.currentThought = null;
    state.lastUser = null;
    state.toolCards.clear();
    state.toolGroup = null;
    state.turnSteps = null;
    state.turnId = null;
    state.turnSeq = 0;
    state.turnHadText = false;
    state.turnEnded = false;
    state.planEl = null;
    state.currentAction = null;
    state.liveToolId = null;
    state.liveStartedAt = null;
    state.liveKey = null;
    stopLiveClock();
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
    messagesEl.replaceChildren(emptyEl);
    emptyEl.hidden = true;
    updateUsageBar();
  }

  function scrollToBottom() {
    if (state.autoScroll) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function jumpToBottom() {
    state.autoScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const settle = () => {
      if (state.autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(settle));
    } else {
      setTimeout(settle, 50);
    }
  }

  function focusComposer() {
    jumpToBottom();
    try {
      inputEl.focus();
    } catch {
      // The webview may not allow focusing a disabled element yet.
    }
  }

  function setStatus(kind, text) {
    state.statusKind = kind;
    state.connected = kind === 'ready' || kind === 'busy' || kind === 'cancelling';
    if (kind === 'busy' || kind === 'cancelling') state.busy = true;
    if (kind === 'ready' || kind === 'error' || kind === 'connecting') state.busy = false;
    statusEl.className = 'status ' + kind;
    statusTextEl.textContent = text || STATUS_LABELS[kind] || kind;
    stopBtn.disabled = kind === 'cancelling';
    syncLiveFallback();
    if (!state.busy) {
      stopLiveClock();
      state.liveStartedAt = null;
      state.liveKey = null;
    }
    updateComposer();
  }

  function setTitle(title) {
    if (!title) return;
    titleEl.textContent = title;
    document.title = title;
    if (state.sessionId) {
      subtitleEl.textContent = 'ACP · ' + shortId(state.sessionId);
      subtitleEl.title = state.sessionId;
    }
  }

  function setSession(message) {
    state.sessionId = message.sessionId || null;
    if (message.cwd) state.cwd = message.cwd;
    if (state.sessionId) {
      subtitleEl.textContent =
        (message.loaded ? 'ACP · ' : 'new session · ') + shortId(state.sessionId);
      subtitleEl.title = state.sessionId;
    }
    try {
      vscode.setState({ sessionId: state.sessionId, cwd: state.cwd });
    } catch {
      // Ignore state persistence errors.
    }
    updateComposer();
  }

  function updateComposer() {
    const canType = state.connected;
    const hasImages = state.images.length > 0;
    inputEl.disabled = !canType;
    inputEl.placeholder = !canType
      ? state.statusKind === 'connecting'
        ? 'Connecting…'
        : 'Disconnected'
      : state.busy
        ? 'OpenCode is working — type to queue…'
        : 'Ask OpenCode…';
    sendBtn.disabled =
      !canType ||
      (state.busy && hasImages) ||
      (inputEl.value.trim() === '' && !hasImages);
    stopBtn.hidden = !state.busy;
    if (!canType) closeSlashMenu();
  }

  function resizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  function renderAttachments() {
    attachmentsEl.replaceChildren();
    attachmentsEl.hidden = state.images.length === 0;
    for (const image of state.images) {
      const chip = el('div', 'attachment');
      const thumb = document.createElement('img');
      thumb.src = image.dataUrl;
      thumb.alt = image.name || 'image';
      thumb.title = image.name || 'image';
      const remove = el('button', 'attachment-remove', '×');
      remove.type = 'button';
      remove.title = 'Remove image';
      remove.setAttribute('aria-label', 'Remove image');
      remove.addEventListener('click', () => {
        state.images = state.images.filter((item) => item.id !== image.id);
        renderAttachments();
        updateComposer();
      });
      chip.appendChild(thumb);
      chip.appendChild(remove);
      attachmentsEl.appendChild(chip);
    }
  }

  function addImageFiles(files) {
    const maxBytes = 10 * 1024 * 1024;
    for (const file of files) {
      if (!file || !file.type || !file.type.startsWith('image/')) continue;
      if (file.size > maxBytes) {
        addInfo(`Image is too large (${Math.round(file.size / 1024 / 1024)} MB).`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return;
        state.images.push({
          id: state.nextImageId++,
          name: file.name || 'pasted-image',
          mimeType: file.type || 'image/png',
          data: dataUrl.slice(comma + 1),
          dataUrl,
        });
        renderAttachments();
        updateComposer();
      };
      reader.onerror = () => addInfo('Failed to read the pasted image.');
      reader.readAsDataURL(file);
    }
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
        description: String(
          (skill && (skill.description || skill.name)) || ''
        ),
        insert: '@' + id + ' ',
      });
    }

    state.slashItems = items;
    return items;
  }

  function slashQuery() {
    const value = inputEl.value;
    if (value.startsWith('/') === false) return null;
    if (/\s/.test(value)) return null;
    return value.slice(1);
  }

  function filteredSlashItems(query) {
    const needle = String(query || '').toLowerCase();
    if (!needle) return state.slashItems;
    const startsWith = state.slashItems.filter((item) =>
      item.name.toLowerCase().startsWith(needle)
    );
    if (startsWith.length > 0) return startsWith;
    return state.slashItems.filter((item) =>
      item.name.toLowerCase().includes(needle)
    );
  }

  function renderSlashMenu(items) {
    slashMenuEl.replaceChildren();
    const limit = Math.min(items.length, 12);
    if (limit === 0) {
      closeSlashMenu();
      return;
    }
    if (state.slashIndex >= limit) state.slashIndex = 0;
    for (let index = 0; index < limit; index += 1) {
      const item = items[index];
      const row = el('button', 'slash-item');
      row.type = 'button';
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.classList.toggle('selected', index === state.slashIndex);
      row.appendChild(el('span', 'slash-kind', item.kind === 'skill' ? 'skill' : 'cmd'));
      row.appendChild(el('span', 'slash-name', item.kind === 'skill' ? '@' + item.name : '/' + item.name));
      const description = el('span', 'slash-desc', item.description || '');
      description.title = item.description || '';
      row.appendChild(description);
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => selectSlashItem(index));
      slashMenuEl.appendChild(row);
    }
    slashMenuEl.hidden = false;
    state.slashOpen = true;
  }

  function refreshSlashMenu() {
    const query = slashQuery();
    if (query === null || !state.connected) {
      closeSlashMenu();
      return;
    }
    buildSlashItems();
    renderSlashMenu(filteredSlashItems(query));
  }

  function closeSlashMenu() {
    slashMenuEl.hidden = true;
    state.slashOpen = false;
    state.slashIndex = 0;
  }

  function moveSlashSelection(delta) {
    if (!state.slashOpen) return;
    const query = slashQuery();
    const items = filteredSlashItems(query);
    if (items.length === 0) return;
    const size = Math.min(items.length, 12);
    state.slashIndex = (state.slashIndex + delta + size) % size;
    renderSlashMenu(items);
  }

  function selectSlashItem(index) {
    const query = slashQuery();
    const items = filteredSlashItems(query);
    const item = items[index];
    if (!item) return;
    inputEl.value = item.insert;
    closeSlashMenu();
    resizeInput();
    updateComposer();
    inputEl.focus();
    const position = inputEl.value.length;
    try {
      inputEl.setSelectionRange(position, position);
    } catch {
      // Older webviews may not support selection ranges.
    }
  }

  function knownCommand(text) {
    const match = String(text || '').match(/^\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const name = match[1];
    const exists = state.slashItems.some(
      (item) => item.kind === 'command' && item.name === name
    );
    if (!exists) return null;
    return { name, text: String(match[2] || '').trim() };
  }

  function sendPrompt() {
    const text = inputEl.value.trim();
    const images = state.images.slice();
    const wasBusy = state.busy;
    if ((!text && images.length === 0) || !state.connected) return;
    if (wasBusy && images.length > 0) {
      addInfo('Image attachments cannot be queued while OpenCode is working.');
      return;
    }
    const command =
      wasBusy || images.length > 0 ? null : knownCommand(text);
    addUserMessage(text, null, images);
    if (command) {
      state.commandEchoIndex = state.userMessageCount - 1;
      state.commandEchoText = text;
    }
    inputEl.value = '';
    state.images = [];
    renderAttachments();
    resizeInput();
    closeSlashMenu();
    if (!wasBusy) {
      state.busy = true;
      if (!state.liveStartedAt) {
        state.liveStartedAt = Date.now();
        state.liveKey = 'working';
      }
      setStatus('busy');
    }
    updateComposer();
    if (command) {
      vscode.postMessage({
        type: 'command',
        name: command.name,
        text: command.text,
      });
    } else {
      vscode.postMessage({
        type: 'prompt',
        text,
        images: images.map((image) => ({
          data: image.data,
          mimeType: image.mimeType,
          name: image.name,
        })),
      });
    }
    inputEl.focus();
  }

  function stopPrompt() {
    if (!state.busy) return;
    setStatus('cancelling');
    vscode.postMessage({ type: 'cancel' });
  }

  function isAssistantMessage(node) {
    const classes = String(node.className || '').split(/\s+/);
    return classes.includes('message') && classes.includes('assistant');
  }

  /**
   * Start a new turn: steps blocks and statistics are attributed to it through
   * `data-turn`, and the empty-answer check runs per turn.
   */
  function beginTurn() {
    state.turnSeq += 1;
    state.turnId = `turn-${state.turnSeq}`;
    state.turnHadText = false;
    state.turnEnded = false;
    state.liveStartedAt = null;
    state.liveKey = null;
    stopLiveClock();
  }

  function ensureTurnSteps() {
    if (state.turnSteps) return state.turnSteps;
    if (state.turnEnded || !state.turnId) beginTurn();
    const details = document.createElement('details');
    details.className = 'turn-steps';
    details.dataset.turn = state.turnId || '';
    details.open = false;
    const summary = document.createElement('summary');
    const titleEl = el('span', 'kind', 'Steps');
    const metaEl = el('span', 'name', '');
    const tokensEl = el('span', 'tokens', '');
    summary.appendChild(titleEl);
    summary.appendChild(metaEl);
    summary.appendChild(tokensEl);
    const liveEl = el('span', 'live');
    liveEl.hidden = true;
    const liveKindEl = el('span', 'live-kind');
    const liveTextEl = el('span', 'live-text');
    const liveTimeEl = el('span', 'live-time');
    const liveTokensEl = el('span', 'tokens');
    liveEl.appendChild(liveKindEl);
    liveEl.appendChild(liveTextEl);
    liveEl.appendChild(liveTimeEl);
    liveEl.appendChild(liveTokensEl);
    summary.appendChild(liveEl);
    const body = el('div', 'body');
    details.appendChild(summary);
    details.appendChild(body);
    messagesEl.appendChild(details);
    state.turnSteps = {
      details,
      body,
      titleEl,
      metaEl,
      tokensEl,
      liveEl,
      liveKindEl,
      liveTextEl,
      liveTimeEl,
      liveTokensEl,
    };
    syncLiveFallback();
    return state.turnSteps;
  }

  /**
   * The live line shows how long the current turn has been working, e.g.
   * "working for 1m 37s". The clock starts with the first update of a turn and
   * is refreshed once a second while the line is visible.
   */
  function renderLiveElapsed() {
    const steps = state.turnSteps;
    if (!steps) {
      stopLiveClock();
      return;
    }
    steps.liveTimeEl.textContent = state.liveStartedAt
      ? `for ${formatElapsed(Date.now() - state.liveStartedAt)}`
      : '';
  }

  function startLiveClock() {
    if (state.liveClock) return;
    state.liveClock = setInterval(renderLiveElapsed, 1000);
  }

  function stopLiveClock() {
    if (!state.liveClock) return;
    clearInterval(state.liveClock);
    state.liveClock = null;
  }

  function markLiveStart(key) {
    const next = key || 'action';
    // A new action restarts the clock; updates of the same tool keep it.
    if (!state.liveStartedAt || state.liveKey !== next) {
      state.liveStartedAt = Date.now();
      state.liveKey = next;
    }
    startLiveClock();
    renderLiveElapsed();
  }

  function setLiveAction(kind, text, tokens, key) {
    const steps = state.turnSteps;
    if (!steps) return;
    state.currentAction = { kind, text, tokens };
    steps.liveKindEl.textContent = kind;
    steps.liveTextEl.textContent = text || '';
    steps.liveTextEl.hidden = !text;
    steps.liveTextEl.title = state.currentAction.text || '';
    steps.liveTokensEl.textContent = tokens ? formatTokens(tokens) : '';
    steps.liveTokensEl.title = 'Estimated from streamed content';
    steps.liveEl.hidden = false;
    markLiveStart(key);
  }

  function syncLiveFallback() {
    const steps = state.turnSteps;
    if (!steps) return;
    if (state.currentAction) return;
    if (state.busy) {
      steps.liveKindEl.textContent = 'working';
      steps.liveTextEl.textContent = '';
      steps.liveTextEl.hidden = true;
      steps.liveTextEl.title = '';
      steps.liveTokensEl.textContent = '';
      steps.liveTokensEl.title = '';
      steps.liveEl.hidden = false;
      markLiveStart('working');
    } else {
      steps.liveEl.hidden = true;
    }
  }

  function clearLiveAction() {
    state.currentAction = null;
    state.liveToolId = null;
    syncLiveFallback();
  }

  /**
   * Container for steps (thoughts, plan, tools). Assistant text never goes in
   * here: `finalizeAssistant` closes the current block before rendering text,
   * so every block holds only the work between two answers.
   */
  function beginIntermediate() {
    const steps = ensureTurnSteps();
    syncTurnSteps();
    return steps;
  }

  function syncTurnSteps() {
    const steps = state.turnSteps;
    if (!steps) return;
    let count = 0;
    let totalTokens = 0;
    const kinds = [];
    for (const child of steps.body.children) {
      const classes = String(child.className || '').split(/\s+/);
      if (classes.includes('tool-group')) {
        const entries = child.querySelectorAll('.tool-entry');
        count += entries.length;
        totalTokens += Number(child.dataset.tokens || 0);
        for (const entry of entries) {
          const kindEl = entry.querySelector('.kind');
          const kind = kindEl ? kindEl.textContent : 'tool';
          if (kind && !kinds.includes(kind)) kinds.push(kind);
        }
      } else {
        count += 1;
        const ownTokens = Number(child.dataset.tokens || 0);
        totalTokens +=
          ownTokens > 0
            ? ownTokens
            : isAssistantMessage(child)
              ? estimateTokens(child.textContent)
              : 0;
        if (classes.includes('thought')) {
          if (!kinds.includes('thought')) kinds.push('thought');
        } else if (classes.includes('plan')) {
          if (!kinds.includes('plan')) kinds.push('plan');
        } else if (isAssistantMessage(child)) {
          if (!kinds.includes('text')) kinds.push('text');
        }
      }
    }
    steps.titleEl.textContent = `${count} step${count === 1 ? '' : 's'}`;
    steps.metaEl.textContent =
      kinds.slice(0, 4).join(' · ') + (kinds.length > 4 ? ' …' : '');
    steps.tokensEl.textContent = totalTokens ? formatTokens(totalTokens) : '';
    steps.tokensEl.title = totalTokens
      ? 'Estimated tokens for this turn'
      : '';
  }

  function finalizeTurnSteps() {
    const steps = state.turnSteps;
    if (!steps) return;
    syncTurnSteps();
    state.currentAction = null;
    state.liveToolId = null;
    state.liveStartedAt = null;
    state.liveKey = null;
    stopLiveClock();
    steps.liveEl.hidden = true;
    state.turnSteps = null;
  }

  /** Steps blocks of the turn that is currently being rendered. */
  function currentTurnBlocks() {
    const turn = state.turnId || '';
    return Array.from(messagesEl.querySelectorAll('.turn-steps')).filter(
      (block) => (block.dataset.turn || '') === turn
    );
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

  /** A turn can end without any assistant text; say why instead of showing nothing. */
  function noTextAnswer(stopReason) {
    switch (stopReason) {
      case 'cancelled':
        return 'The turn was stopped before the model wrote an answer.';
      case 'max_tokens':
        return 'The model reached its output limit before writing an answer.';
      case 'refusal':
        return 'The model refused to answer.';
      case 'error':
        return 'The turn failed before the model wrote an answer.';
      default:
        return stopReason
          ? `No answer from the model (stop reason: ${stopReason}).`
          : 'No answer from the model.';
    }
  }

  /**
   * Steps blocks grouped per turn. A turn can now render several chevrons,
   * separated by answers, so statistics are applied to the block of a turn
   * that holds all of its work — and only when the turn has exactly one.
   */
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

  /**
   * Replace counters rebuilt from the server history. ACP replay carries no
   * token metadata, so a restored turn would otherwise show smaller numbers
   * than the turn that produced it.
   */
  function applyTurnStats(turns, scope) {
    if (!Array.isArray(turns) || turns.length === 0) return;
    const groups = turnStepGroups();
    if (groups.length === 0) return;
    if (scope === 'last') {
      const group = groups[groups.length - 1];
      if (state.turnSteps && group.includes(state.turnSteps.details)) {
        // A newer turn already started; its counters belong to the live stream.
        return;
      }
      const turn = group[0].dataset.turn || '';
      if (turn !== (state.turnId || '')) return;
      if (group.length === 1) applyTurnStat(group[0], turns[turns.length - 1]);
      return;
    }
    const count = Math.min(groups.length, turns.length);
    const groupStart = groups.length - count;
    const turnStart = turns.length - count;
    for (let index = 0; index < count; index += 1) {
      const group = groups[groupStart + index];
      if (group.length !== 1) continue;
      applyTurnStat(group[0], turns[turnStart + index]);
    }
  }

  function applyTurnStat(details, stat) {
    if (!details || !stat) return;
    if (details.dataset.exact === '1') return;
    const summary = details.querySelector('summary');
    if (!summary) return;
    const titleEl = summary.querySelector(':scope > .kind');
    const metaEl = summary.querySelector(':scope > .name');
    const tokensEl = summary.querySelector(':scope > .tokens');
    const steps = Number(stat.steps) || 0;
    const totalTokens = Number(stat.tokens) || 0;
    if (titleEl) {
      titleEl.textContent = `${steps} step${steps === 1 ? '' : 's'}`;
    }
    if (metaEl) {
      const kinds = Array.isArray(stat.kinds) ? stat.kinds : [];
      metaEl.textContent =
        kinds.slice(0, 4).join(' · ') + (kinds.length > 4 ? ' …' : '');
    }
    details.dataset.tokens = String(totalTokens);
    if (tokensEl) {
      const exact = stat.exact === true;
      tokensEl.textContent = formatTurnTokens(
        totalTokens,
        stat.cacheRead,
        stat.cacheWrite,
        exact
      );
      tokensEl.title = totalTokens
        ? exact
          ? 'Billed tokens for this turn, read back from the server history'
          : 'Estimated tokens for this turn, rebuilt from the server history'
        : '';
    }
    if (stat.exact === true) details.dataset.exact = '1';
  }

  /**
   * The server reports exact token usage when the turn ends. Replace the
   * estimate built from streamed content with those numbers.
   */
  function applyBilledUsage(usage, block) {
    if (!usage || typeof usage.totalTokens !== 'number') return;
    if (usage.totalTokens <= 0 || !block) return;
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
    if (typeof usage.inputTokens === 'number') {
      parts.push(`input ${formatCompact(usage.inputTokens)}`);
    }
    if (typeof usage.outputTokens === 'number') {
      parts.push(`output ${formatCompact(usage.outputTokens)}`);
    }
    if (typeof usage.thoughtTokens === 'number') {
      parts.push(`reasoning ${formatCompact(usage.thoughtTokens)}`);
    }
    if (typeof usage.cachedReadTokens === 'number') {
      parts.push(`cache read ${formatCompact(usage.cachedReadTokens)}`);
    }
    if (typeof usage.cachedWriteTokens === 'number') {
      parts.push(`cache write ${formatCompact(usage.cachedWriteTokens)}`);
    }
    tokensEl.title = parts.length
      ? `Billed tokens for this turn: ${parts.join(' · ')}`
      : 'Billed tokens for this turn';
  }

  function addInfo(text) {
    if (!text) return;
    finalizeToolGroup();
    hideEmpty();
    const target = state.turnSteps ? state.turnSteps.body : messagesEl;
    target.appendChild(el('div', 'info', text));
    if (state.turnSteps) syncTurnSteps();
    scrollToBottom();
  }

  function addError(text) {
    if (!text) return;
    finalizeThought();
    finalizeAssistant();
    finalizeToolGroup();
    finalizeTurnSteps();
    hideEmpty();
    messagesEl.appendChild(el('div', 'error', text));
    state.busy = false;
    updateComposer();
    scrollToBottom();
  }

  function addUserMessage(text, messageId, images) {
    finalizeThought();
    finalizeAssistant();
    finalizeToolGroup();
    finalizeTurnSteps();
    hideEmpty();

    if (messageId && state.lastUser && state.lastUser.messageId === messageId) {
      state.lastUser.text += text;
      state.lastUser.body.textContent = state.lastUser.text;
      state.lastUser.body.hidden = !state.lastUser.text;
      scrollToBottom();
      return;
    }

    // A user message starts a new turn.
    beginTurn();

    const wrap = el('div', 'message user');
    const body = el('div', 'body', text);
    body.hidden = !text;
    wrap.appendChild(body);
    if (Array.isArray(images) && images.length > 0) {
      const gallery = el('div', 'user-images');
      for (const image of images) {
        const thumb = document.createElement('img');
        thumb.src = image.dataUrl;
        thumb.alt = image.name || 'image';
        thumb.title = image.name || 'image';
        thumb.addEventListener('load', () => scrollToBottom());
        gallery.appendChild(thumb);
      }
      wrap.appendChild(gallery);
    }
    messagesEl.appendChild(wrap);
    state.userMessageCount += 1;
    state.lastUser = { messageId: messageId || null, body, text };
    scrollToBottom();
  }

  function createAssistant(messageId) {
    const wrap = el('div', 'message assistant');
    wrap.hidden = true;
    const body = el('div', 'body');
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    const assistant = { messageId: messageId || null, wrap, body, text: '', finalized: false };
    state.currentAssistant = assistant;
    return assistant;
  }

  function addAssistantChunk(content, messageId) {
    if (!content || content.type !== 'text' || typeof content.text !== 'string' || !content.text) {
      return;
    }
    if (state.currentThought) finalizeThought();
    finalizeToolGroup();
    clearLiveAction();
    hideEmpty();

    let assistant = state.currentAssistant;
    if (
      !assistant ||
      assistant.finalized ||
      (messageId && assistant.messageId && messageId !== assistant.messageId)
    ) {
      if (assistant) finalizeAssistant();
      assistant = createAssistant(messageId);
    }
    // The text is rendered only once the message is complete, so the answer never
    // appears as raw streaming text before it is formatted.
    assistant.text += content.text;
    scrollToBottom();
  }

  function finalizeAssistant() {
    const assistant = state.currentAssistant;
    if (!assistant) return;
    assistant.finalized = true;
    if (!assistant.text.trim()) {
      assistant.wrap.remove();
    } else {
      assistant.wrap.hidden = false;
      assistant.body.classList.add('md');
      assistant.body.innerHTML = renderMarkdown(assistant.text);
      scheduleFileChecks();
      // The answer is printed outside the chevron: close the block that holds
      // the steps before it, so later steps open a new one below the text.
      state.turnHadText = true;
      finalizeTurnSteps();
      scrollToBottom();
    }
    state.currentAssistant = null;
  }

  function createThought(messageId) {
    // Text that arrived before this thought must stay outside the chevron.
    finalizeAssistant();
    const details = document.createElement('details');
    details.className = 'thought streaming';
    details.open = false;
    const summary = document.createElement('summary');
    const labelEl = el('span', 'thought-label', 'Thinking…');
    const tokensEl = el('span', 'tokens', '');
    summary.appendChild(labelEl);
    summary.appendChild(tokensEl);
    const body = el('div', 'body');
    details.appendChild(summary);
    details.appendChild(body);
    beginIntermediate().body.appendChild(details);
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
    };
    state.currentThought = thought;
    return thought;
  }

  function addThoughtChunk(content, messageId) {
    if (!content || content.type !== 'text' || typeof content.text !== 'string' || !content.text) {
      return;
    }
    finalizeToolGroup();
    clearLiveAction();
    hideEmpty();
    let thought = state.currentThought;
    if (!thought) {
      thought = createThought(messageId);
    }
    thought.text += content.text;
    thought.body.textContent = thought.text;
    thought.tokens = estimateTokens(thought.text);
    thought.tokensEl.textContent = formatTokens(thought.tokens);
    thought.tokensEl.title = 'Estimated from streamed content';
    thought.details.dataset.tokens = String(thought.tokens);
    syncTurnSteps();
    scrollToBottom();
  }

  function finalizeThought() {
    const thought = state.currentThought;
    if (!thought) return;
    thought.details.classList.remove('streaming');
    thought.details.open = false;
    thought.labelEl.textContent = 'Thoughts';
    state.currentThought = null;
  }

  function toolStatusLabel(status) {
    switch (status) {
      case 'pending':
        return 'pending';
      case 'in_progress':
        return 'running';
      case 'completed':
        return 'done';
      case 'failed':
        return 'failed';
      default:
        return status || '';
    }
  }

  function toolTitle(toolCall) {
    if (!toolCall) return 'tool';
    return toolCall.title || toolCall.name || toolCall.kind || 'tool';
  }

  /**
   * ACP sends a tool call's arguments as `rawInput`, either as an object or as
   * a JSON string. Normalise it so callers can just read fields.
   */
  function toolInputObject(update) {
    const input = update && update.rawInput;
    if (!input) return null;
    if (typeof input === 'object' && !Array.isArray(input)) return input;
    if (typeof input === 'string') {
      const text = input.trim();
      if (!text.startsWith('{')) return null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Not JSON; fall through.
      }
    }
    return null;
  }

  /**
   * The `subagent` tool spawns child sessions. Its arguments carry the agent
   * name, a human description, and the prompt, which no other tool combines.
   */
  function isSubagentTool(update) {
    const input = toolInputObject(update);
    if (!input) return false;
    return (
      typeof input.prompt === 'string' &&
      (typeof input.agent === 'string' || typeof input.description === 'string')
    );
  }

  function subagentLabel(update) {
    const input = toolInputObject(update);
    if (input) {
      if (typeof input.description === 'string' && input.description.trim()) {
        return input.description;
      }
      if (typeof input.agent === 'string' && input.agent.trim()) {
        return input.agent;
      }
    }
    return (update && update.title) || 'sub-agent';
  }

  function actionLabel(kind) {
    switch (kind) {
      case 'execute':
        return 'run';
      case 'read':
        return 'read';
      case 'edit':
        return 'edit';
      case 'write':
        return 'write';
      default:
        return kind || 'tool';
    }
  }

  function describeTool(update) {
    const input = update && update.rawInput;
    if (typeof input === 'string') return oneLine(input);
    if (input && typeof input === 'object') {
      if (typeof input.command === 'string') return oneLine(input.command);
      if (typeof input.path === 'string') return oneLine(input.path);
      if (typeof input.filePath === 'string') return oneLine(input.filePath);
      if (typeof input.pattern === 'string') {
        return oneLine(
          input.path ? `${input.pattern} in ${input.path}` : input.pattern
        );
      }
      if (typeof input.url === 'string') return oneLine(input.url);
    }
    const locations = update && update.locations;
    if (Array.isArray(locations) && locations[0] && locations[0].path) {
      return oneLine(locations[0].path);
    }
    return oneLine(
      (update && (update.title || update.name || update.kind)) || 'tool'
    );
  }

  function toolCommand(update) {
    const input = update && update.rawInput;
    if (input && typeof input.command === 'string') {
      const command = input.command.trim();
      if (command) return command;
    }
    return describeTool(update);
  }

  function toolInputText(update) {
    const input = update && update.rawInput;
    if (input === undefined || input === null || input === '') return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object' && Object.keys(input).length === 0) return '';
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
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

  function createToolGroup() {
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
    beginIntermediate().body.appendChild(details);
    const group = { details, kindEl, nameEl, tokensEl, statusEl, body, cards: [] };
    state.toolGroup = group;
    syncTurnSteps();
    return group;
  }

  function syncToolGroup(group) {
    if (!group || group.cards.length === 0) return;
    const count = group.cards.length;
    if (count === 1) {
      group.kindEl.textContent = group.cards[0].kind || 'Tool';
      group.nameEl.textContent = group.cards[0].nameEl.textContent || '';
    } else {
      const kinds = [];
      for (const card of group.cards) {
        const kind = card.kind || card.kindEl.textContent;
        if (kind && !kinds.includes(kind)) kinds.push(kind);
      }
      group.kindEl.textContent = `${count} steps`;
      group.nameEl.textContent =
        kinds.slice(0, 4).join(' · ') + (kinds.length > 4 ? ' …' : '');
    }
    group.details.classList.toggle('single', count === 1);

    const statuses = group.cards.map((card) => card.statusValue).filter(Boolean);
    let status = '';
    if (statuses.includes('in_progress')) status = 'in_progress';
    else if (statuses.includes('pending')) status = 'pending';
    else if (statuses.includes('failed')) status = 'failed';
    else if (statuses.length > 0 && statuses.every((value) => value === 'completed')) {
      status = 'completed';
    }
    group.statusEl.textContent = status ? toolStatusLabel(status) : '';
    group.statusEl.className = 'status' + (status ? ' ' + status : '');
    const totalTokens = group.cards.reduce((sum, card) => sum + (card.tokens || 0), 0);
    group.tokensEl.textContent = formatTokens(totalTokens);
    group.tokensEl.title = totalTokens
      ? 'Estimated tokens for these operations'
      : '';
    group.details.dataset.tokens = String(totalTokens);
  }

  function finalizeToolGroup() {
    const group = state.toolGroup;
    if (!group) return;
    syncToolGroup(group);
    state.toolGroup = null;
  }

  function createToolCard(update) {
    const subagent = isSubagentTool(update);
    const group = state.toolGroup || createToolGroup();
    const entry = el('div', subagent ? 'tool-entry subagent-entry' : 'tool-entry');
    const header = el('div', 'tool-entry-header');
    const kindEl = el('span', 'kind', subagent ? 'sub-agent' : update.kind || 'tool');
    const nameEl = el(
      'span',
      'name',
      subagent ? subagentLabel(update) : update.title || update.kind || 'tool'
    );
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
      statusValue: null,
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
    state.toolCards.set(update.toolCallId, card);
    syncToolGroup(group);
    syncTurnSteps();
    return card;
  }

  function renderLocations(card, locations) {
    const row = card.rows.files;
    if (!row) return;
    if (!Array.isArray(locations) || locations.length === 0) return;
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

  function toolContentText(update) {
    const parts = [];
    if (Array.isArray(update.content)) {
      for (const item of update.content) {
        if (!item) continue;
        if (item.type === 'content' && item.content) {
          if (item.content.type === 'text' && typeof item.content.text === 'string') {
            parts.push(item.content.text);
          } else if (typeof item.content === 'string') {
            parts.push(item.content);
          }
        } else if (item.type === 'diff') {
          const path = item.path || 'diff';
          const before = typeof item.oldText === 'string' ? item.oldText : '';
          const after = typeof item.newText === 'string' ? item.newText : '';
          parts.push(`--- ${path}\n${before}\n+++ ${path}\n${after}`);
        } else if (item.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
        }
      }
    }
    if (parts.length === 0 && update.rawOutput !== undefined) {
      try {
        parts.push(JSON.stringify(update.rawOutput, null, 2));
      } catch {
        // Ignore unserializable output.
      }
    }
    let text = parts.join('\n\n');
    text = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    if (text.length > 20000) text = text.slice(0, 20000) + '\n…';
    return text;
  }

  function renderToolContent(card, update) {
    const input = toolInputText(update);
    if (input && card.rows.input) {
      card.inputText = input;
      setToolPre(card.rows.input, input);
    }
    const text = toolContentText(update);
    if (text && card.rows.output) {
      card.outputText = text;
      setToolPre(card.rows.output, text);
    }
    card.tokens =
      estimateTokens(card.inputText) + estimateTokens(card.outputText);
    card.tokensEl.textContent = formatTokens(card.tokens);
    card.tokensEl.title = card.tokens
      ? 'Estimated tokens for this operation'
      : '';
    card.entry.dataset.tokens = String(card.tokens);
  }

  function upsertTool(update) {
    if (!update || !update.toolCallId) return;
    let card = state.toolCards.get(update.toolCallId);
    if (!card) {
      finalizeAssistant();
      finalizeThought();
      hideEmpty();
      card = createToolCard(update);
    }
    if (card.subagent) {
      const label = subagentLabel(update);
      if (label) card.nameEl.textContent = label;
    } else {
      if (update.kind) {
        card.kind = update.kind;
        card.kindEl.textContent = update.kind;
      }
      if (update.title) card.nameEl.textContent = update.title;
    }
    if (update.status) {
      card.statusValue = update.status;
      card.statusEl.textContent = toolStatusLabel(update.status);
      card.statusEl.className = 'status ' + update.status;
    }
    renderLocations(card, update.locations);
    renderToolContent(card, update);
    if (!card.subagent) {
      card.body.hidden = !Object.values(card.rows).some((row) => !row.row.hidden);
    }
    syncToolGroup(card.group);
    syncTurnSteps();
    if (card.statusValue === 'pending' || card.statusValue === 'in_progress') {
      state.liveToolId = update.toolCallId;
      const kind = actionLabel(card.kind);
      const isRun = kind === 'run';
      setLiveAction(
        kind,
        card.subagent
          ? card.nameEl.textContent
          : isRun
            ? prefixLine(toolCommand(update))
            : describeTool(update),
        card.tokens,
        update.toolCallId
      );
    } else if (state.liveToolId === update.toolCallId) {
      clearLiveAction();
    }
    scrollToBottom();
  }

  function addPlan(update) {
    hideEmpty();
    finalizeAssistant();
    finalizeThought();
    finalizeToolGroup();
    const container = beginIntermediate().body;
    const isLast =
      state.planEl &&
      state.planEl.container === container &&
      container.lastElementChild === state.planEl.details;
    if (!isLast) {
      const details = document.createElement('details');
      details.className = 'plan';
      details.open = false;
      const summary = el('summary', 'plan-title');
      summary.appendChild(el('span', 'plan-label', 'Plan'));
      const tokensEl = el('span', 'tokens', '');
      summary.appendChild(tokensEl);
      const entries = el('div', 'plan-entries');
      details.appendChild(summary);
      details.appendChild(entries);
      container.appendChild(details);
      state.planEl = { details, entries, container, tokensEl };
    }
    const entries = state.planEl.entries;
    entries.replaceChildren();
    const planEntries = Array.isArray(update.entries) ? update.entries : [];
    for (const entry of planEntries) {
      const row = el('div', 'plan-entry ' + (entry.status || 'pending'));
      const marker =
        entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◐' : '○';
      row.appendChild(el('span', 'marker', marker));
      row.appendChild(el('span', null, entry.content || ''));
      entries.appendChild(row);
    }
    const planTokens = estimateTokens(
      planEntries.map((entry) => entry.content || '').join(' ')
    );
    state.planEl.tokensEl.textContent = formatTokens(planTokens);
    state.planEl.tokensEl.title = planTokens
      ? 'Estimated tokens for the plan'
      : '';
    state.planEl.details.dataset.tokens = String(planTokens);
    syncTurnSteps();
    scrollToBottom();
  }

  function addPermission(message) {
    hideEmpty();
    finalizeAssistant();
    finalizeThought();
    finalizeToolGroup();
    finalizeTurnSteps();

    const card = el('div', 'permission');
    card.appendChild(el('div', 'permission-title', 'Permission required'));
    card.appendChild(el('div', 'permission-tool', toolTitle(message.toolCall)));
    const actions = el('div', 'permission-actions');
    const options = Array.isArray(message.options) ? message.options : [];

    for (const option of options) {
      const allow = /^(allow|approve)/i.test(String(option.kind || '')) || /allow|approve/i.test(String(option.name || ''));
      const button = el('button', allow ? 'allow' : 'reject', option.name || option.optionId);
      button.addEventListener('click', () => {
        if (card.dataset.resolved === '1') return;
        card.dataset.resolved = '1';
        for (const item of actions.querySelectorAll('button')) item.disabled = true;
        const note = el('div', 'permission-note', 'Selected: ' + (option.name || option.optionId));
        card.appendChild(note);
        vscode.postMessage({
          type: 'permissionResponse',
          requestId: message.requestId,
          optionId: option.optionId,
        });
      });
      actions.appendChild(button);
    }

    if (options.length === 0) {
      const button = el('button', 'reject', 'Cancel');
      button.addEventListener('click', () => {
        if (card.dataset.resolved === '1') return;
        card.dataset.resolved = '1';
        for (const item of actions.querySelectorAll('button')) item.disabled = true;
        card.appendChild(el('div', 'permission-note', 'Cancelled'));
        vscode.postMessage({
          type: 'permissionResponse',
          requestId: message.requestId,
          optionId: null,
        });
      });
      actions.appendChild(button);
    }

    card.appendChild(actions);
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function addElicitation(message) {
    hideEmpty();
    finalizeAssistant();
    finalizeThought();
    finalizeToolGroup();
    finalizeTurnSteps();

    const schema = message.requestedSchema || {};
    const properties = (schema && schema.properties) || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const controls = {};
    const limits = {};

    const card = el('div', 'elicitation');
    card.appendChild(el('div', 'permission-title', 'Question'));
    if (typeof message.message === 'string' && message.message) {
      card.appendChild(el('div', 'elicitation-message', message.message));
    }

    const form = el('div', 'elicitation-form');
    for (const name of Object.keys(properties)) {
      const field = buildElicitationField(name, properties[name], required, controls, limits);
      if (field) form.appendChild(field);
    }
    card.appendChild(form);

    const actions = el('div', 'permission-actions');
    const submit = el('button', 'allow', 'Submit');
    const cancel = el('button', 'reject', 'Decline');

    const feedback = el('div', 'permission-note');

    function note(text) {
      feedback.textContent = text;
      if (feedback.parentNode !== card) card.appendChild(feedback);
    }

    submit.addEventListener('click', () => {
      const missing = required.filter((name) => {
        const value = controls[name] ? controls[name]() : null;
        if (
          value !== undefined &&
          value !== null &&
          value !== '' &&
          !(Array.isArray(value) && value.length === 0)
        ) {
          return false;
        }
        return true;
      });
      if (missing.length > 0) {
        note('Please fill in all required fields.');
        return;
      }
      for (const name of Object.keys(limits)) {
        const value = controls[name] ? controls[name]() : null;
        const count = Array.isArray(value) ? value.length : 0;
        const limit = limits[name] || {};
        const label = properties[name] && properties[name].title ? properties[name].title : name;
        if (Number.isFinite(limit.minItems) && count < limit.minItems) {
          note('Select at least ' + limit.minItems + ' option(s) for "' + label + '".');
          return;
        }
        if (Number.isFinite(limit.maxItems) && count > limit.maxItems) {
          note('Select at most ' + limit.maxItems + ' option(s) for "' + label + '".');
          return;
        }
      }
      resolve('accept');
    });
    cancel.addEventListener('click', () => resolve('decline'));

    function resolve(action) {
      if (card.dataset.resolved === '1') return;
      card.dataset.resolved = '1';
      for (const item of actions.querySelectorAll('button')) item.disabled = true;
      const payload = { type: 'elicitationResponse', requestId: message.requestId, action };
      if (action === 'accept') payload.content = collectElicitationContent(controls);
      vscode.postMessage(payload);
      note(action === 'accept' ? 'Submitted.' : 'Declined.');
    }

    actions.appendChild(submit);
    actions.appendChild(cancel);
    card.appendChild(actions);
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function buildElicitationField(name, prop, required, controls, limits) {
    if (!prop || typeof prop !== 'object') return null;
    const type = prop.type;
    const isRequired = required.indexOf(name) !== -1;
    const label = prop.title || name;

    const row = el('div', 'elicitation-field');
    const labelEl = el('label', 'elicitation-label', isRequired ? label + ' *' : label);
    row.appendChild(labelEl);

    if (
      type === 'string' &&
      (Array.isArray(prop.enum) || Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf))
    ) {
      const choices = elicitationChoices(prop);
      const selected =
        prop.default === undefined || prop.default === null ? [] : [String(prop.default)];
      const box = buildChoiceList(name, choices, false, selected);
      row.appendChild(box);
      controls[name] = () => {
        const checked = box.querySelector('input:checked');
        return checked && checked.value !== '' ? checked.value : null;
      };
    } else if (type === 'boolean') {
      const checkbox = el('input', 'elicitation-input');
      checkbox.type = 'checkbox';
      checkbox.id = 'elic-' + name;
      labelEl.setAttribute('for', checkbox.id);
      if (prop.default === true) checkbox.checked = true;
      row.appendChild(checkbox);
      controls[name] = () => checkbox.checked;
    } else if (type === 'array') {
      const items = prop.items || {};
      const choices = elicitationChoices(items);
      if (choices.length > 0) {
        const rawSelected = Array.isArray(prop.default)
          ? prop.default
          : prop.default === undefined || prop.default === null
            ? []
            : [prop.default];
        const selected = rawSelected.map((value) => String(value));
        const box = buildChoiceList(name, choices, true, selected);
        row.appendChild(box);
        controls[name] = () => {
          const picked = [];
          for (const checkbox of box.querySelectorAll('input[type="checkbox"]')) {
            if (checkbox.checked) picked.push(checkbox.value);
          }
          return picked;
        };
        const minItems = Number.isFinite(prop.minItems) && prop.minItems > 0 ? prop.minItems : 0;
        const maxItems = Number.isFinite(prop.maxItems) ? prop.maxItems : null;
        if (minItems > 0 || maxItems !== null) {
          limits[name] = { minItems, maxItems };
          row.appendChild(
            el('div', 'elicitation-description', elicitationRangeHint(minItems, maxItems))
          );
        }
      } else {
        // The protocol sends multi-select as an array of enumerated values; fall
        // back to a comma-separated box for schemas without a fixed value set.
        const input = el('input', 'elicitation-input');
        input.id = 'elic-' + name;
        input.type = 'text';
        input.placeholder = 'Comma-separated values';
        labelEl.setAttribute('for', input.id);
        if (Array.isArray(prop.default) && prop.default.length > 0) {
          input.value = prop.default.join(', ');
        }
        row.appendChild(input);
        const numeric = items.type === 'number' || items.type === 'integer';
        controls[name] = () => {
          const raw = String(input.value).trim();
          if (raw === '') return [];
          return raw
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== '')
            .map((item) => (numeric ? Number(item) : item))
            .filter((item) => !numeric || Number.isFinite(item));
        };
      }
    } else {
      const input = el('input', 'elicitation-input');
      input.id = 'elic-' + name;
      input.type = type === 'number' || type === 'integer' ? 'number' : 'text';
      labelEl.setAttribute('for', input.id);
      if (type === 'integer') input.step = '1';
      if (prop.minimum !== undefined) input.min = String(prop.minimum);
      if (prop.maximum !== undefined) input.max = String(prop.maximum);
      if (prop.minLength !== undefined) input.minLength = String(prop.minLength);
      if (prop.maxLength !== undefined) input.maxLength = String(prop.maxLength);
      if (prop.pattern !== undefined) input.pattern = String(prop.pattern);
      if (prop.default !== undefined && prop.default !== null) {
        input.value = String(prop.default);
      }
      row.appendChild(input);
      controls[name] = () => {
        const raw = String(input.value).trim();
        if (raw === '') return null;
        if (type === 'number' || type === 'integer') {
          const number = Number(raw);
          return Number.isFinite(number) ? number : null;
        }
        return raw;
      };
    }

    if (prop.description) {
      row.appendChild(el('div', 'elicitation-description', prop.description));
    }
    return row;
  }

  // Single choice arrives as a string with oneOf/enum, multi choice as an array
  // whose items carry anyOf/enum (see the ACP elicitation form schema).
  function elicitationChoices(source) {
    const choices = [];
    if (!source || typeof source !== 'object') return choices;
    const entries = Array.isArray(source.oneOf)
      ? source.oneOf
      : Array.isArray(source.anyOf)
        ? source.anyOf
        : Array.isArray(source.enum)
          ? source.enum
          : [];
    for (const entry of entries) {
      if (entry && typeof entry === 'object') {
        const value = entry.const !== undefined ? entry.const : entry.value;
        if (value === undefined || value === null) continue;
        choices.push({
          value: String(value),
          label: entry.title || entry.label || String(value),
          description: typeof entry.description === 'string' ? entry.description : '',
        });
      } else if (entry !== undefined && entry !== null) {
        choices.push({ value: String(entry), label: String(entry), description: '' });
      }
    }
    return choices;
  }

  function buildChoiceList(name, choices, multiple, selected) {
    const box = el('div', 'elicitation-options');
    for (const choice of choices) {
      const optionRow = el('label', 'elicitation-option');
      const input = el('input', 'elicitation-choice');
      input.type = multiple ? 'checkbox' : 'radio';
      input.value = choice.value;
      if (!multiple) input.name = 'elic-group-' + name;
      if (selected.indexOf(choice.value) !== -1) input.checked = true;
      optionRow.appendChild(input);
      const body = el('span', 'elicitation-option-body');
      body.appendChild(el('span', 'elicitation-option-label', choice.label));
      if (choice.description) {
        body.appendChild(el('span', 'elicitation-description', choice.description));
      }
      optionRow.appendChild(body);
      box.appendChild(optionRow);
    }
    return box;
  }

  function elicitationRangeHint(min, max) {
    if (max !== null && min > 0) return 'Select ' + min + ' to ' + max + '.';
    if (max !== null) return 'Select up to ' + max + '.';
    return 'Select at least ' + min + '.';
  }

  function collectElicitationContent(controls) {
    const content = {};
    for (const name of Object.keys(controls)) {
      const value = controls[name]();
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      content[name] = value;
    }
    return content;
  }

  function updateUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    const next = { ...(state.usage || {}) };
    if (typeof usage.used === 'number') next.used = usage.used;
    if (typeof usage.size === 'number' && usage.size > 0) next.size = usage.size;
    if (usage.cost && typeof usage.cost === 'object') next.cost = usage.cost;
    if (typeof usage.totalTokens === 'number') next.totalTokens = usage.totalTokens;
    if (typeof usage.inputTokens === 'number') next.inputTokens = usage.inputTokens;
    if (typeof usage.outputTokens === 'number') next.outputTokens = usage.outputTokens;
    if (typeof usage.thoughtTokens === 'number') next.thoughtTokens = usage.thoughtTokens;
    if (typeof usage.cachedReadTokens === 'number') {
      next.cachedReadTokens = usage.cachedReadTokens;
    }
    if (typeof usage.cachedWriteTokens === 'number') {
      next.cachedWriteTokens = usage.cachedWriteTokens;
    }
    state.usage = next;
    updateUsageBar();
  }

  // Mirrors the server: the provider-declared input window wins over the
  // context window; a configured buffer shorter than it is subtracted,
  // otherwise the default is max(15% of the window, 16k for windows >= 32k).
  function compactionThreshold(context, input) {
    const total = Number(input) || Number(context) || 0;
    if (total <= 0) return 0;
    const compaction = state.compaction || {};
    if (compaction.auto === false) return 0;
    const buffer = Number(compaction.buffer);
    if (Number.isFinite(buffer) && buffer < total) return total - buffer;
    return total - Math.max(Math.floor(total * 0.15), total >= 32000 ? 16000 : 0);
  }

  function updateUsageBar() {
    if (!usageEl) return;
    usageEl.title = 'Context usage · compaction threshold';
    usageResetEl.title = 'Budget reset time';
    const usage = state.usage;
    const cache = state.cacheStats;
    const limit = state.modelLimit || {};
    const context = Number(limit.context) || Number(usage && usage.size) || 0;
    const prompt = cache && Number(cache.prompt) > 0 ? Number(cache.prompt) : 0;
    if (!usage && prompt <= 0) {
      usageEl.textContent = 'tokens: —';
    } else if ((usage && typeof usage.used === 'number') || prompt > 0) {
      const used = prompt || Number(usage && usage.used) || 0;
      const parts = [`tokens: ${formatCompact(used)}${cacheSuffix(cache)}`];
      const threshold = compactionThreshold(context, limit.input);
      const window = Number(limit.input) || context;
      if (threshold > 0) {
        parts.push(
          `compaction at ${formatCompact(threshold)}` +
            (window > 0 ? ` (${formatCompact(window)} limit)` : '')
        );
      }
      usageEl.textContent = parts.join(' · ');
    } else if (usage && typeof usage.totalTokens === 'number') {
      usageEl.textContent = `tokens: ${formatCompact(usage.totalTokens)} billed this turn`;
    } else {
      usageEl.textContent = 'tokens: —';
    }

    const cost = usage && usage.cost;
    const currency = (cost && cost.currency) || 'USD';
    const parentCost = cost && typeof cost.amount === 'number' ? cost.amount : 0;
    const subagentCost = Number(state.subagentCost) || 0;
    let costText = '';
    if (cost && typeof cost.amount === 'number') {
      costText = `cost: ${formatCost(parentCost + subagentCost, currency)}`;
      if (subagentCost > 0) {
        costText += ` (sub-agents ${formatCost(subagentCost, currency)})`;
      }
    } else if (subagentCost > 0) {
      costText = `cost: ${formatCost(subagentCost, currency)} (sub-agents)`;
    }
    const budget = state.budget;
    if (budget && typeof budget.remaining === 'number') {
      const suffix =
        budget.modelMatched && budget.label ? ` for ${budget.label}` : '';
      costText +=
        (costText ? ' · ' : '') + `$${budget.remaining.toFixed(2)} left${suffix}`;
    }
    const balance = state.balance;
    if (balance && typeof balance.amount === 'number') {
      costText +=
        (costText ? ' · ' : '') +
        `balance: ${formatMoney(balance.amount, balance.currency)}`;
    }
    usageCostEl.textContent = costText;
    usageCostEl.hidden = !costText;
    usageCostEl.title = costTooltip(state.costSplit, subagentCost);

    const resetAt = nextReset(state.limits, budget);
    if (resetAt) {
      usageResetEl.textContent = `reset in ${formatDuration(resetAt - Date.now())}`;
      usageResetEl.hidden = false;
    } else {
      usageResetEl.textContent = '';
      usageResetEl.hidden = true;
    }
  }

  /**
   * Per-tariff spending for the cost tooltip. The extension accounts every step
   * with its own stored cost, so the amounts already reflect peak-hour rates
   * and model switches; only the totals are shown, never single messages. The
   * amounts share a decimal column, the labels carry no numbers.
   */
  function costTooltip(split, subagentCost) {
    if (!split || !Array.isArray(split.rows) || split.rows.length === 0) {
      return 'Spent cost and remaining budget';
    }
    const entries = [];
    for (const row of split.rows) {
      if (!(Number(row.tokens) > 0)) continue;
      entries.push({
        cost: formatCost(row.cost, 'USD'),
        label: row.label || row.key,
      });
    }
    const subagents = Number(subagentCost) || 0;
    if (subagents > 0) {
      entries.push({ cost: formatCost(subagents, 'USD'), label: 'sub-agents' });
    }
    const aligned = alignMoney(entries.map((entry) => entry.cost));
    const lines = [`Spent ${formatCost(split.total, 'USD')}`];
    aligned.forEach((item, index) => {
      lines.push(`  · ${item}  ${entries[index].label}`);
    });
    return lines.join('\n');
  }

  /**
   * Right-aligns amounts on the decimal separator, so `$0.1477` and `$12.3456`
   * keep their points in one column.
   */
  function alignMoney(values) {
    const parts = values.map((value) => {
      const text = String(value);
      const dot = text.indexOf('.');
      return dot < 0
        ? { head: text, tail: '' }
        : { head: text.slice(0, dot), tail: text.slice(dot) };
    });
    const width = parts.reduce((max, part) => Math.max(max, part.head.length), 0);
    return parts.map((part) => part.head.padStart(width) + part.tail);
  }

  function formatCost(amount, currency) {
    const value = Number(amount) || 0;
    return currency && currency !== 'USD'
      ? `${value.toFixed(4)} ${currency}`
      : `$${value.toFixed(4)}`;
  }

  function formatMoney(amount, currency) {
    const value = Number(amount) || 0;
    return currency && currency !== 'USD'
      ? `${value.toFixed(2)} ${currency}`
      : `$${value.toFixed(2)}`;
  }

  function nextReset(limits, budget) {
    const now = Date.now();
    if (
      budget &&
      typeof budget.resetsAt === 'number' &&
      budget.resetsAt > now
    ) {
      return budget.resetsAt;
    }
    if (!limits) return 0;
    const times = [];
    if (limits.go) {
      for (const key of ['rolling', 'weekly', 'monthly']) {
        const meter = limits.go[key];
        if (meter && typeof meter.resetsAt === 'number') times.push(meter.resetsAt);
      }
    }
    if (Array.isArray(limits.budgets)) {
      for (const item of limits.budgets) {
        if (item && typeof item.resetsAt === 'number') times.push(item.resetsAt);
      }
    }
    const future = times.filter((time) => time > now).sort((a, b) => a - b);
    return future[0] || 0;
  }

  /**
   * Share of the last prompt that came from the provider cache, plus how long
   * ago it was measured. Both are exact: `cache.read` and the prompt size come
   * from the stored counters of the newest assistant message. The share is
   * floored to three decimals, so it only reaches 100% when nothing was new.
   */
  function cacheSuffix(cache) {
    const prompt = cache && Number(cache.prompt) > 0 ? Number(cache.prompt) : 0;
    if (prompt <= 0) return '';
    const read = Number(cache.read) || 0;
    const percent = Math.floor((read / prompt) * 100000) / 1000;
    const pieces = [`${percent}% cached`];
    const ago = formatAgo(cache.at);
    if (ago) pieces.push(ago);
    return ` (${pieces.join(' ')})`;
  }

  function formatAgo(at) {
    const time = Number(at) || 0;
    if (time <= 0) return '';
    const elapsed = Date.now() - time;
    if (!Number.isFinite(elapsed) || elapsed < 60000) return 'just now';
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 36) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /** Short elapsed label for the live line, e.g. "12s", "1m 37s", "2h 5m". */
  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${rest}s`;
    return `${rest}s`;
  }

  function estimateTokens(text) {
    const value = String(text || '');
    if (!value.trim()) return 0;
    return Math.max(1, Math.ceil(value.length / 4));
  }

  function oneLine(text, maxLength = 140) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    if (value.length <= maxLength) return value;
    return '…' + value.slice(-maxLength);
  }

  function prefixLine(text, maxLength = 120) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength) + '…';
  }

  function formatTokens(value) {
    if (!value) return '';
    return '~' + formatCompact(value) + ' tok';
  }

  function formatExactTokens(value) {
    if (!value) return '';
    return formatCompact(value) + ' tok';
  }

  /**
   * Turn header counters. The leading number is what the turn cost outside the
   * provider cache — input plus output plus reasoning — so the `+` terms in
   * parentheses add up to the billed total instead of repeating it.
   */
  function formatTurnTokens(total, cacheRead, cacheWrite, exact) {
    const billed = Number(total) || 0;
    if (billed <= 0) return '';
    const read = Number(cacheRead) || 0;
    const write = Number(cacheWrite) || 0;
    const core = Math.max(0, billed - read - write);
    const extra = [];
    if (read > 0) extra.push(`+${formatCompact(read)} cache read`);
    if (write > 0) extra.push(`+${formatCompact(write)} cache write`);
    const head = `${exact ? '' : '~'}${formatCompact(core)} tok`;
    return extra.length ? `${head} (${extra.join(' · ')})` : head;
  }

  function formatCompact(value) {
    const number = Number(value) || 0;
    if (number >= 1000000) {
      return (number / 1000000).toFixed(number >= 10000000 ? 0 : 1) + 'M';
    }
    if (number >= 1000) {
      // Keep one decimal so 84200 reads as 84.2k, and drop a trailing .0.
      return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return String(number);
  }

  function isReadOnlyMode(option) {
    return Boolean(option) && (option.id === 'mode' || option.category === 'mode');
  }

  function appendReadOnlyToggle(option) {
    const label = el('label', 'config');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = option.currentValue === 'plan';
    checkbox.title =
      option.description ||
      'Read Only: Plan agent when checked, Build agent otherwise';
    checkbox.addEventListener('change', () => {
      checkbox.disabled = true;
      vscode.postMessage({
        type: 'setConfigOption',
        configId: option.id,
        value: checkbox.checked ? 'plan' : 'build',
      });
    });
    label.appendChild(checkbox);
    label.appendChild(el('span', null, 'Read Only'));
    configBarEl.appendChild(label);
  }

  function setConfigOptions(options) {
    configBarEl.replaceChildren();
    const list = Array.isArray(options) ? options : [];
    for (const option of list) {
      if (!option) continue;
      if (isReadOnlyMode(option)) {
        appendReadOnlyToggle(option);
        continue;
      }
      if (option.type !== 'select' || !Array.isArray(option.options)) continue;
      const label = el('label', 'config');
      label.appendChild(el('span', null, option.name || option.id));
      const select = document.createElement('select');
      if (option.description) select.title = option.description;
      for (const item of option.options) {
        const choice = document.createElement('option');
        choice.value = item.value;
        choice.textContent = item.name || item.value;
        if (item.description) choice.title = item.description;
        if (item.value === option.currentValue) choice.selected = true;
        select.appendChild(choice);
      }
      select.addEventListener('change', () => {
        select.disabled = true;
        vscode.postMessage({
          type: 'setConfigOption',
          configId: option.id,
          value: select.value,
        });
      });
      label.appendChild(select);
      configBarEl.appendChild(label);
    }
    configBarEl.hidden = configBarEl.children.length === 0;
  }

  function isSkippedReplayUser(update) {
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
        if (state.commandEchoText) addUserMessage(state.commandEchoText, id);
        return true;
      }
    }
    return false;
  }

  /**
   * Agents that were not told that this client handles child-session updates
   * fold sub-agent output into the parent stream and tag it with `_meta`. Such
   * an update belongs to another session's transcript: rendering it here would
   * split the parent's text into fragments, so it is dropped. Live sub-agent
   * progress is shown by the sub-agents strip instead.
   */
  function isChildSessionUpdate(update) {
    const meta = update && update._meta;
    const child = meta && meta['opencode/child-session'];
    return Boolean(child && child.id);
  }

  function handleUpdate(update) {
    if (!update || typeof update !== 'object') return;
    if (isChildSessionUpdate(update)) return;
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        if (isSkippedReplayUser(update)) break;
        if (update.content && update.content.type === 'text' && typeof update.content.text === 'string') {
          addUserMessage(update.content.text, update.messageId || null);
        }
        break;
      case 'agent_message_chunk':
        addAssistantChunk(update.content, update.messageId || null);
        break;
      case 'agent_thought_chunk':
        addThoughtChunk(update.content, update.messageId || null);
        break;
      case 'tool_call':
      case 'tool_call_update':
        upsertTool(update);
        break;
      case 'plan':
        addPlan(update);
        break;
      case 'usage_update':
        updateUsage(update);
        break;
      case 'session_info_update':
        if (update.title) setTitle(update.title);
        break;
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) setConfigOptions(update.configOptions);
        break;
      case 'available_commands_update':
        state.acpCommands = Array.isArray(update.availableCommands)
          ? update.availableCommands
          : [];
        buildSlashItems();
        if (state.slashOpen) refreshSlashMenu();
        break;
      default:
        break;
    }
  }

  function handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'status':
        setStatus(message.state, message.message);
        break;
      case 'session':
        setSession(message);
        break;
      case 'capabilities':
        state.imageSupport = Boolean(message.images);
        break;
      case 'slashItems':
        state.skills = Array.isArray(message.skills) ? message.skills : [];
        state.restCommands = Array.isArray(message.commands) ? message.commands : [];
        buildSlashItems();
        if (state.slashOpen) refreshSlashMenu();
        break;
      case 'historyReset':
        resetTranscript();
        break;
      case 'sessionInfo':
        setTitle(message.title);
        break;
      case 'focus':
        focusComposer();
        break;
      case 'config':
        setConfigOptions(message.configOptions);
        break;
      case 'limits':
        state.limits = message.limits || null;
        state.budget = message.budget || null;
        updateUsageBar();
        break;
      case 'balance':
        state.balance = message.balance || null;
        updateUsageBar();
        break;
      case 'modelLimit':
        state.modelLimit = {
          context: Number(message.context) || 0,
          input: Number(message.input) || 0,
        };
        updateUsageBar();
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
        updateUsageBar();
        break;
      case 'costSplit':
        state.costSplit =
          message && Array.isArray(message.rows) && message.rows.length > 0
            ? {
                total: Number(message.total) || 0,
                rows: message.rows.map((row) => ({
                  key: String(row.key || ''),
                  label: String(row.label || row.key || ''),
                  tokens: Number(row.tokens) || 0,
                  cost: Number(row.cost) || 0,
                })),
              }
            : null;
        updateUsageBar();
        break;
      case 'compaction':
        state.compaction = message.compaction || null;
        updateUsageBar();
        break;
      case 'update':
        handleUpdate(message.update);
        break;
      case 'permission':
        addPermission(message);
        break;
      case 'elicitation':
        addElicitation(message);
        break;
      case 'fileChecks':
        applyFileCheckResults(message.files);
        break;
      case 'historyEnd':
        state.skipUserIndex = -1;
        state.skipUserId = null;
        state.commandEchoText = '';
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        finalizeTurnSteps();
        jumpToBottom();
        break;
      case 'turnEnd': {
        const fresh = !state.turnEnded;
        const blocks = fresh ? currentTurnBlocks() : [];
        const block = blocks.length <= 1 ? blocks[0] || null : null;
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        state.busy = false;
        finalizeTurnSteps();
        if (message.usage) {
          // Turn totals are only exact for a turn rendered as a single block;
          // a turn split by an answer keeps its per-block estimates.
          if (block) applyBilledUsage(message.usage, block);
          updateUsage(message.usage);
        }
        if (fresh && !state.turnHadText) {
          const steps = blocks.reduce((sum, item) => sum + countBlockSteps(item), 0);
          if (steps > 0) {
            for (const item of blocks) item.open = true;
            addInfo(
              `No text answer in this turn — ${steps} step${steps === 1 ? '' : 's'} listed above.`
            );
          } else {
            addInfo(noTextAnswer(message.stopReason));
          }
        } else if (fresh && message.stopReason === 'cancelled') {
          addInfo('Stopped by user.');
        }
        if (fresh) state.turnEnded = true;
        setStatus('ready');
        break;
      }
      case 'turnStats':
        applyTurnStats(message.turns, message.scope);
        break;
      case 'subagents':
        state.subagentCost = Number(message.totalCost) || 0;
        renderSubagents(Array.isArray(message.items) ? message.items : []);
        updateUsageBar();
        break;
      case 'info':
        addInfo(message.text);
        break;
      case 'error':
        addError(message.message);
        break;
      default:
        break;
    }
  }

  function renderSubagents(items) {
    if (!subagentsEl) return;
    if (!items || items.length === 0) {
      subagentsEl.hidden = true;
      subagentsListEl.replaceChildren();
      state.subagentsRunning = 0;
      return;
    }

    subagentsEl.hidden = false;

    const running = items.filter((item) => item.running).length;
    const totalTokens = items.reduce((sum, item) => sum + (item.tokens || 0), 0);
    const allExact = items.every((item) => item.exact === true || !item.tokens);
    const countParts = [];
    if (running > 0) countParts.push(`${running} running`);
    countParts.push(`${items.length} total`);
    let summary = countParts.join(' · ');
    if (totalTokens > 0) {
      summary +=
        ' · ' +
        (allExact ? '' : '~') +
        formatCompact(totalTokens) +
        ' tok';
    }
    subagentsSummaryTextEl.textContent = summary;

    // Expand once when sub-agents start running, then leave the user's toggle
    // alone so the strip can be collapsed during a long run.
    if (running > 0 && !state.subagentsRunning) {
      setSubagentsExpanded(true);
    }
    state.subagentsRunning = running;

    subagentsListEl.replaceChildren();
    for (const item of items) {
      const li = el('li', 'subagent');
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.title = 'Open sub-agent session';
      const head = el('div', 'subagent-head');
      const spinner = el('span', 'subagent-spinner' + (item.running ? ' running' : ''));
      spinner.textContent = item.running ? '◌' : '✓';
      const title = el('span', 'subagent-title', item.title || 'Sub-agent');
      head.appendChild(spinner);
      head.appendChild(title);
      const meta = el('div', 'subagent-meta');
      if (item.action) meta.appendChild(el('span', 'subagent-action', item.action));
      if (item.tokens) {
        meta.appendChild(
          el(
            'span',
            'subagent-tokens',
            item.exact ? formatExactTokens(item.tokens) : formatTokens(item.tokens)
          )
        );
      } else if (!item.running) {
        meta.appendChild(
          el('span', 'subagent-tokens', item.exact ? '0 tok' : '~0 tok')
        );
      }
      li.appendChild(head);
      li.appendChild(meta);
      li.addEventListener('click', () => {
        if (item.id) vscode.postMessage({ type: 'openSession', sessionId: item.id });
      });
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (item.id) vscode.postMessage({ type: 'openSession', sessionId: item.id });
        }
      });
      subagentsListEl.appendChild(li);
    }
  }

  function setSubagentsExpanded(expanded) {
    subagentsSummaryEl.setAttribute('aria-expanded', String(expanded));
    subagentsListEl.hidden = !expanded;
    const chevron = subagentsSummaryEl.querySelector('.subagents-chevron');
    if (chevron) chevron.textContent = expanded ? '▾' : '▸';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return character;
      }
    });
  }

  const FILE_EXTENSIONS =
    'js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|mdx|css|scss|sass|less|html|htm|' +
    'xml|ya?ml|toml|ini|cfg|conf|txt|sh|bash|zsh|py|go|rs|c|cc|cpp|cxx|' +
    'h|hh|hpp|hxx|java|kt|kts|rb|php|swift|m|mm|lua|pl|proto|sql|gn|gni|' +
    'cmake|gradle|lock|svg';
  const FILE_REF = new RegExp(
    '(^|[^\\w/.:@-])' +
      '((?:\\.{1,2}/|/|~/)?(?:[\\w.@+-]+/)*[\\w.@+-]+\\.(?:' +
      FILE_EXTENSIONS +
      '))' +
      '(?:#L(\\d+)|:(\\d+))?(?::(\\d+))?' +
      '(?![\\w/])',
    'g'
  );
  const FILE_TARGET = new RegExp(
    '^(?:\\.{1,2}/|/|~/)?(?:[\\w.@+-]+/)*[\\w.@+-]+\\.(?:' +
      FILE_EXTENSIONS +
      ')(?:#L\\d+(?:C\\d+)?|:\\d+(?::\\d+)?)?$'
  );

  function fileLinkParts(value) {
    const raw = String(value || '').trim();
    if (!FILE_TARGET.test(raw)) return null;

    let file = raw;
    let line = '';
    let column = '';
    const hash = file.match(/^(.*?)#L(\d+)(?:C(\d+))?$/i);
    if (hash) {
      file = hash[1];
      line = hash[2];
      column = hash[3] || '';
    } else {
      const colon = file.match(/^(.*?):(\d+)(?::(\d+))?$/);
      if (colon) {
        file = colon[1];
        line = colon[2];
        column = colon[3] || '';
      }
    }
    return { file, line, column };
  }

  // The input is already HTML-escaped, so ampersands and quotes are safe
  // both in the label and in the data attributes. A reference stays plain
  // text until the extension confirms that the file exists.
  function fileToken(parts, label) {
    let attributes = ' data-file="' + parts.file + '"';
    if (parts.line) attributes += ' data-line="' + parts.line + '"';
    if (parts.column) attributes += ' data-column="' + parts.column + '"';
    return '<span class="file-ref"' + attributes + '>' + label + '</span>';
  }

  function renderInline(value) {
    let text = escapeHtml(value);
    const tokens = [];
    const protect = (html) => {
      tokens.push(html);
      return '\u0001' + (tokens.length - 1) + '\u0001';
    };

    text = text.replace(/`([^`\n]+)`/g, (match, code) => {
      const parts = fileLinkParts(code);
      if (parts) return protect(fileToken(parts, code));
      return protect('<code>' + code + '</code>');
    });

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, target) => {
      if (/^https?:\/\//i.test(target)) {
        return protect('<a href="#" data-href="' + target + '">' + label + '</a>');
      }
      const parts = fileLinkParts(target);
      if (!parts) return match;
      return protect(fileToken(parts, label));
    });

    // Bare URLs must not be mistaken for local paths.
    text = text.replace(/https?:\/\/[^\s<>"']+/g, (url) => protect(url));

    text = text.replace(
      FILE_REF,
      (match, prefix, file, hashLine, colonLine, column) => {
        const line = hashLine || colonLine || '';
        const label =
          file +
          (line ? (hashLine ? '#L' + line : ':' + line) : '') +
          (column ? ':' + column : '');
        return prefix + fileToken({ file, line, column: column || '' }, label);
      }
    );

    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    text = text.replace(/\u0001(\d+)\u0001/g, (match, index) => tokens[Number(index)]);
    return text;
  }

  function fileRefKey(node) {
    return [
      node.dataset.file || '',
      node.dataset.line || '',
      node.dataset.column || '',
    ].join('\u0000');
  }

  // Ask the extension which candidates are real files and only then style
  // them as links. Unknown paths stay plain text.
  function applyFileChecks() {
    if (!messagesEl || typeof messagesEl.querySelectorAll !== 'function') return;
    const pending = [];
    for (const node of messagesEl.querySelectorAll('.file-ref')) {
      if (!node.dataset || !node.dataset.file) continue;
      const key = fileRefKey(node);
      const exists = state.fileChecks.get(key);
      if (exists === true) {
        node.classList.add('file-link');
      } else if (exists === false) {
        node.classList.remove('file-link');
      } else if (!state.fileCheckPending.has(key) && pending.length < 100) {
        state.fileCheckPending.add(key);
        pending.push({
          key,
          path: node.dataset.file,
          line: node.dataset.line || null,
          column: node.dataset.column || null,
        });
      }
    }
    if (pending.length > 0) {
      vscode.postMessage({ type: 'checkFiles', files: pending });
    }
  }

  let fileCheckTimer = null;

  function scheduleFileChecks() {
    if (fileCheckTimer) clearTimeout(fileCheckTimer);
    fileCheckTimer = setTimeout(() => {
      fileCheckTimer = null;
      applyFileChecks();
    }, 120);
  }

  function applyFileCheckResults(results) {
    if (!Array.isArray(results)) return;
    for (const result of results) {
      if (!result || typeof result.key !== 'string') continue;
      state.fileChecks.set(result.key, result.exists === true);
      state.fileCheckPending.delete(result.key);
    }
    applyFileChecks();
  }

  function splitTableRow(line) {
    let value = String(line || '').trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = [];
    let current = '';
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '\\' && value[index + 1] === '|') {
        current += '|';
        index += 1;
        continue;
      }
      if (character === '`') inCode = !inCode;
      if (character === '|' && !inCode) {
        cells.push(current.trim());
        current = '';
        continue;
      }
      current += character;
    }
    cells.push(current.trim());
    return cells;
  }

  function tableAlignments(line) {
    const cells = splitTableRow(line);
    const alignments = [];
    for (const cell of cells) {
      if (!/^:?-+:?$/.test(cell)) return null;
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      alignments.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
    }
    return alignments.length > 0 ? alignments : null;
  }

  function tableAlignmentClass(alignment) {
    return alignment ? ' class="align-' + alignment + '"' : '';
  }

  function renderTable(headerLine, rows, alignments) {
    const header = splitTableRow(headerLine);
    const columns = alignments.length;
    const cellText = (cells, index) => (index < cells.length ? cells[index] : '');
    const head = [];
    for (let index = 0; index < columns; index += 1) {
      head.push(
        '<th' + tableAlignmentClass(alignments[index]) + '>' +
          renderInline(cellText(header, index)) +
          '</th>'
      );
    }
    const body = rows.map((row) => {
      const cells = splitTableRow(row);
      const rendered = [];
      for (let index = 0; index < columns; index += 1) {
        rendered.push(
          '<td' + tableAlignmentClass(alignments[index]) + '>' +
            renderInline(cellText(cells, index)) +
            '</td>'
        );
      }
      return '<tr>' + rendered.join('') + '</tr>';
    });
    return (
      '<div class="table-wrap"><table><thead><tr>' +
      head.join('') +
      '</tr></thead>' +
      (body.length > 0 ? '<tbody>' + body.join('') + '</tbody>' : '') +
      '</table></div>'
    );
  }

  function renderMarkdown(source) {
    const text = String(source || '').replace(/\r\n/g, '\n');
    const codeBlocks = [];
    const withoutFences = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (match, language, code) => {
      const languageName = String(language || '').trim();
      const attribute = languageName ? ' data-lang="' + escapeHtml(languageName) + '"' : '';
      codeBlocks.push(
        '<pre><code' + attribute + '>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>'
      );
      return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
    });

    const lines = withoutFences.split('\n');
    const output = [];
    let paragraph = [];
    let listType = null;
    let listItems = [];
    let quote = [];

    function flushParagraph() {
      if (paragraph.length > 0) {
        output.push('<p>' + paragraph.map(renderInline).join('<br>') + '</p>');
        paragraph = [];
      }
    }

    function flushList() {
      if (listType) {
        output.push(
          '<' + listType + '>' +
            listItems.map((item) => '<li>' + renderInline(item) + '</li>').join('') +
            '</' + listType + '>'
        );
        listType = null;
        listItems = [];
      }
    }

    function flushQuote() {
      if (quote.length > 0) {
        output.push('<blockquote>' + quote.map(renderInline).join('<br>') + '</blockquote>');
        quote = [];
      }
    }

    function flushAll() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (/^\u0000CODE\d+\u0000$/.test(trimmed)) {
        flushAll();
        output.push(trimmed);
        continue;
      }
      if (!trimmed) {
        flushAll();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        output.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        output.push('<hr>');
        continue;
      }
      const quoteMatch = line.match(/^\s*>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quote.push(quoteMatch[1]);
        continue;
      }
      const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        flushParagraph();
        flushQuote();
        const nextType = /^\d+\.$/.test(listMatch[1]) ? 'ol' : 'ul';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push(listMatch[2]);
        continue;
      }
      const nextLine = index + 1 < lines.length ? lines[index + 1] : '';
      const alignments = nextLine.includes('|') ? tableAlignments(nextLine) : null;
      if (alignments && splitTableRow(line).length === alignments.length) {
        flushAll();
        const rows = [];
        let rowIndex = index + 2;
        for (; rowIndex < lines.length; rowIndex += 1) {
          const rowLine = lines[rowIndex];
          const rowTrimmed = rowLine.trim();
          if (!rowTrimmed || !rowTrimmed.includes('|')) break;
          if (/^\u0000CODE\d+\u0000$/.test(rowTrimmed)) break;
          if (/^(#{1,6})\s+/.test(rowTrimmed)) break;
          if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rowLine)) break;
          if (/^\s*>/.test(rowLine)) break;
          if (/^\s*([-*+]|\d+\.)\s+/.test(rowLine)) break;
          rows.push(rowLine);
        }
        output.push(renderTable(line, rows, alignments));
        index = rowIndex - 1;
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(line);
    }
    flushAll();

    return output
      .join('\n')
      .replace(/\u0000CODE(\d+)\u0000/g, (match, index) => codeBlocks[Number(index)]);
  }

  inputEl.addEventListener('input', () => {
    resizeInput();
    updateComposer();
    refreshSlashMenu();
  });

  inputEl.addEventListener('blur', () => closeSlashMenu());

  inputEl.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = [];
    if (clipboard.items) {
      for (let index = 0; index < clipboard.items.length; index += 1) {
        const item = clipboard.items[index];
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    if (files.length === 0 && clipboard.files) {
      for (let index = 0; index < clipboard.files.length; index += 1) {
        const file = clipboard.files[index];
        if (file && file.type && file.type.startsWith('image/')) files.push(file);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    if (!state.imageSupport) {
      addInfo('Image input is not supported by the current agent.');
      return;
    }
    addImageFiles(files);
  });

  inputEl.addEventListener('keydown', (event) => {
    if (state.slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const items = filteredSlashItems(slashQuery());
        if (items.length > 0) {
          event.preventDefault();
          selectSlashItem(state.slashIndex);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
      return;
    }
    if (event.key === 'Escape' && state.busy) {
      event.preventDefault();
      stopPrompt();
    }
  });

  sendBtn.addEventListener('click', sendPrompt);
  stopBtn.addEventListener('click', stopPrompt);

  messagesEl.addEventListener('scroll', () => {
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    state.autoScroll = distance < 120;
  });

  messagesEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const fileLink = target.closest('.file-link[data-file]');
    if (fileLink) {
      event.preventDefault();
      const payload = { type: 'openFile', path: fileLink.dataset.file };
      if (fileLink.dataset.line) payload.line = Number(fileLink.dataset.line);
      if (fileLink.dataset.column) payload.column = Number(fileLink.dataset.column);
      vscode.postMessage(payload);
      return;
    }

    const link = target.closest('a[data-href]');
    if (!link) return;
    event.preventDefault();
    vscode.postMessage({ type: 'openExternal', url: link.getAttribute('data-href') });
  });

  window.addEventListener('message', (event) => handleMessage(event.data));
  if (subagentsSummaryEl) {
    subagentsSummaryEl.addEventListener('click', () => {
      setSubagentsExpanded(
        subagentsSummaryEl.getAttribute('aria-expanded') !== 'true'
      );
    });
  }
  window.addEventListener('focus', () => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    try {
      inputEl.focus();
    } catch {
      // Ignore focus errors in older webviews.
    }
  });

  resizeInput();
  updateComposer();
  updateUsageBar();
  vscode.postMessage({ type: 'ready' });
})();

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const emptyEl = document.getElementById('empty');
  const inputEl = document.getElementById('input');
  const composerEl = document.getElementById('composer');
  const questionsEl = document.getElementById('questions');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const activityDetailEl = document.getElementById('activity-detail');
  const activityOperationEl = document.getElementById('activity-operation');
  const activityTargetEl = document.getElementById('activity-target');
  const activityJump = document.getElementById('activity-jump');
  const usageEl = document.getElementById('usage');
  const usageCostEl = document.getElementById('usage-cost');
  const usageSubscriptionEl = document.getElementById('usage-subscription');
  const usageLinkEl = document.getElementById('usage-link');
  const usageResetEl = document.getElementById('usage-reset');
  const attachmentsEl = document.getElementById('attachments');
  const configBarEl = document.getElementById('config-bar');
  let modelPicker = null;
  const slashMenuEl = document.getElementById('slash-menu');
  const subagentsEl = document.getElementById('subagents');
  const subagentsSummaryEl = document.getElementById('subagents-summary');
  const subagentsSummaryTextEl = document.getElementById('subagents-summary-text');
  const subagentsListEl = document.getElementById('subagents-list');
  const planProgress = document.getElementById('plan-progress');
  const artifacts = OpenCodeRichText.createArtifacts({
    root: document.getElementById('artifacts'), toggle: document.getElementById('artifacts-toggle'),
    renderMarkdown, hydrate: (root) => { OpenCodeRichText.hydrate(root); scheduleFileChecks(); }, post: (message) => vscode.postMessage(message),
    preferences: vscode.getState?.()?.artifacts,
    onAsk: selectContext,
    save: (value) => vscode.setState({ ...vscode.getState?.(), artifacts: value }),
  });

  const STATUS_LABELS = {
    connecting: 'Connecting…',
    ready: 'Ready',
    unconfirmed: 'Execution unconfirmed',
    busy: 'Working…',
    cancelling: 'Stopping…',
    error: 'Error',
  };

  const state = {
    selection: null,
    selectionImages: [],
    artifactSeq: 0,
    connected: false,
    busy: false,
    archived: false,
    statusKind: 'connecting',
    statusText: 'Connecting…',
    sessionId: null,
    cwd: null,
    currentAssistant: null,
    currentThought: null,
    lastUser: null,
    replaying: true,
    messageTimes: new Map(),
    toolCards: new Map(),
    smartReviews: new Map(),
    smartReviewHistory: null,
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
    activityPlan: '',
    activityThought: '',
    activityPurpose: '',
    attentionRequests: new Map(),
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
    nativeTransport: false,
    nativeMessages: new Map(),
    nativeParts: new Map(),
    nativeUsers: new Map(),
    nativeInbox: null,
    pendingInputs: new Map(),
    fileChecks: new Map(),
    fileCheckPending: new Set(),
  };

  planProgress?.addEventListener('click', () => {
    const plan = state.planEl?.details;
    if (!plan) return;
    for (let parent = plan; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    plan.scrollIntoView({ block: 'center' });
    plan.querySelector('summary').focus();
  });
  activityJump.addEventListener('click', () => {
    const request = currentAttention();
    const target = request?.target || state.currentAction?.target;
    if (!target || target.hidden) {
      jumpToBottom();
      return;
    }
    for (let parent = target.parentElement; parent && parent !== messagesEl; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    state.autoScroll = false;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (request) target.querySelector('input, textarea, select, button:not(.disclosure-collapse)')?.focus({ preventScroll: true });
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function hideEmpty() {
    emptyEl.hidden = true;
  }

  function resetTranscript() {
    state.replaying = true;
    state.messageTimes.clear();
    thoughtResize?.disconnect();
    // Keep the latest review snapshot: polls and history replay can arrive in either order.
    state.smartReviewHistory = null;
    if (planProgress) planProgress.hidden = true;
    state.artifactSeq = 0;
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
    state.activityPlan = '';
    state.activityThought = '';
    state.activityPurpose = '';
    for (const target of state.attentionRequests.keys()) {
      if (!questionsEl.contains(target)) state.attentionRequests.delete(target);
    }
    stopLiveClock();
    renderLiveElapsed();
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
    for (const review of state.smartReviews.values()) placeSmartReview(review);
    updateUsageBar();
  }

  function scrollToBottom() {
    if (state.autoScroll) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  let restoredViewport = vscode.getState?.()?.viewport || null;
  let restoredSubmissions = vscode.getState?.()?.submissions || [];
  let viewportTimer;
  function captureViewport() {
    const top = messagesEl.getBoundingClientRect().top;
    const anchor = [...messagesEl.children].find((node) => node.dataset.anchorId &&
      node.getBoundingClientRect().bottom > top);
    return { bottom: state.autoScroll, top: messagesEl.scrollTop,
      anchor: anchor?.dataset.anchorId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
  }

  function restoreViewport(viewport) {
    if (!viewport) return;
    state.autoScroll = viewport.bottom;
    if (viewport.bottom) { scrollToBottom(); return; }
    const anchor = [...messagesEl.children].find((node) => node.dataset.anchorId === viewport.anchor);
    messagesEl.scrollTop = anchor ? messagesEl.scrollTop + anchor.getBoundingClientRect().top -
      messagesEl.getBoundingClientRect().top - viewport.offset : viewport.top;
  }

  function saveViewport() {
    if (state.replaying || restoredViewport) return;
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => vscode.setState({ ...vscode.getState?.(), viewport: captureViewport() }), 80);
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

  function focusComposer(preserveScroll = false) {
    if (state.archived) return;
    if (!questionsEl.hidden) {
      questionsEl.querySelector('.elicitation:not([hidden]) button.allow, .elicitation:not([hidden]) input')?.focus();
      return;
    }
    if (!restoredViewport && (!preserveScroll || state.autoScroll)) jumpToBottom();
    try {
      inputEl.focus();
    } catch {
      // The webview may not allow focusing a disabled element yet.
    }
  }

  function setStatus(kind, text, external = false) {
    state.statusKind = kind;
    state.externalBusy = external && kind === 'busy';
    state.statusText = text || STATUS_LABELS[kind] || kind;
    state.connected = kind === 'ready' || kind === 'unconfirmed' || kind === 'busy' || kind === 'cancelling';
    if (kind === 'busy' || kind === 'cancelling') state.busy = true;
    if (kind === 'ready' || kind === 'unconfirmed' || kind === 'error' || kind === 'connecting') state.busy = false;
    stopBtn.disabled = kind === 'cancelling';
    if (!state.busy || state.externalBusy) {
      stopLiveClock();
      state.currentAction = null;
      state.liveToolId = null;
      state.liveStartedAt = null;
      state.liveKey = null;
      state.activityPlan = '';
      state.activityThought = '';
      state.activityPurpose = '';
      state.attentionRequests.clear();
    }
    syncLiveFallback();
    updateComposer();
  }

  function setTitle(title) {
    if (!title) return;
    document.title = title;
  }

  function setArchived(archived) {
    state.archived = Boolean(archived);
    composerEl.hidden = state.archived;
    if (state.archived) {
      for (const card of questionsEl.children) resolveAttention(card);
      questionsEl.replaceChildren();
      syncQuestions();
    }
    if (state.archived) {
      state.images = [];
      state.selection = null;
      state.selectionImages = [];
      closeSlashMenu();
      renderAttachments();
      const selection = document.getElementById('selection-context');
      selection.replaceChildren();
      selection.hidden = true;
    }
    updateComposer();
  }

  function setSession(message) {
    if (state.sessionId && state.sessionId !== message.sessionId) {
      for (const review of state.smartReviews.values()) review.card.remove();
      state.smartReviews.clear();
      state.smartReviewHistory?.details.remove();
      state.smartReviewHistory = null;
    }
    state.sessionId = message.sessionId || null;
    if (message.cwd) state.cwd = message.cwd;
    try {
      vscode.setState({ ...vscode.getState?.(), sessionId: state.sessionId, cwd: state.cwd });
    } catch {
      // Ignore state persistence errors.
    }
    updateComposer();
  }

  function updateComposer() {
    const canType = state.connected && !state.archived;
    const hasImages = state.images.length + state.selectionImages.length > 0;
    inputEl.disabled = !canType;
    inputEl.placeholder = !canType
      ? state.statusKind === 'connecting'
        ? 'Connecting…'
        : 'Disconnected'
      : state.busy
        ? 'OpenCode is working — type to queue…'
        : state.statusKind === 'unconfirmed'
          ? 'Send a message to continue…'
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

  function selectContext(context, images = []) {
    if (state.archived && context) return;
    state.selection = context;
    state.selectionImages = images;
    const chip = document.getElementById('selection-context');
    chip.replaceChildren();
    chip.hidden = !context;
    if (context) {
      chip.appendChild(el('span', '', `${context.artifact.title} · v${context.artifact.version} · ${context.selection.type}`));
      const clear = el('button', '', 'Remove selection');
      clear.type = 'button';
      clear.addEventListener('click', () => selectContext(null));
      chip.appendChild(clear);
      chip.title = JSON.stringify(context.selection, null, 2);
      for (const image of images) {
        const thumb = el('img');
        thumb.src = image.dataUrl;
        thumb.alt = image.name;
        chip.appendChild(thumb);
      }
    }
    updateComposer();
    inputEl.focus();
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
    if (state.archived) return;
    const text = inputEl.value.trim();
    const images = [...state.images, ...state.selectionImages];
    const selection = state.selection;
    const wasBusy = state.busy;
    if ((!text && images.length === 0) || !state.connected) return;
    if (wasBusy && images.length > 0 && !state.nativeTransport) {
      addInfo('Image attachments cannot be queued while OpenCode is working.');
      return;
    }
    const candidate = images.length > 0 || selection ? null : knownCommand(text);
    const command = !wasBusy || candidate?.name === 'archive' ? candidate : null;
    const id = state.nativeTransport ? `msg_${crypto.randomUUID().replaceAll('-', '')}` : null;
    if (state.nativeTransport && !command) {
      showSubmission({ id, state: 'sending', item: { id, time: { created: Date.now() }, ...(selection ? { selection } : {}), payload: { text,
        files: images.map((image) => ({ uri: image.dataUrl || `data:${image.mimeType};base64,${image.data}` })) } } });
    } else addUserMessage(text, null, images, Date.now());
    if (command) {
      state.commandEchoIndex = state.userMessageCount - 1;
      state.commandEchoText = text;
    }
    inputEl.value = '';
    state.images = [];
    if (selection) selectContext(null);
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
        ...(id ? { id } : {}),
        text,
        ...(selection ? { selection } : {}),
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
    state.currentAction = null;
    state.liveToolId = null;
    state.activityPlan = '';
    state.activityThought = '';
    state.activityPurpose = '';
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
    const metaEl = el('span', 'name step-metrics', '');
    const tokensEl = el('span', 'tokens', '');
    summary.appendChild(titleEl);
    summary.appendChild(metaEl);
    summary.appendChild(tokensEl);
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
    };
    syncLiveFallback();
    return state.turnSteps;
  }

  function currentAttention() {
    return state.attentionRequests.values().next().value;
  }

  function requestAttention(target, kind, summary, text) {
    state.attentionRequests.set(target, { target, kind, summary, text, startedAt: Date.now() });
    startLiveClock();
    renderLiveElapsed();
  }

  function resolveAttention(target) {
    state.attentionRequests.delete(target);
    syncLiveFallback();
  }

  /** The fixed header owns the live activity; step summaries retain history only. */
  function renderLiveElapsed() {
    const request = state.statusKind === 'cancelling' ? null : currentAttention();
    const active = request || (state.busy ? state.currentAction : null);
    const kind = request ? 'attention' : state.statusKind;
    const summary = request?.summary || (state.busy && !state.externalBusy && kind !== 'cancelling'
      ? state.activityThought || state.activityPlan || state.activityPurpose || active?.summary || state.statusText
      : state.statusText);
    statusEl.className = 'status ' + kind;
    statusEl.title = request ? 'Needs your input' : STATUS_LABELS[kind] || kind;
    if (statusTextEl.textContent !== summary) statusTextEl.textContent = summary;
    statusTextEl.title = summary;
    const startedAt = request?.startedAt ?? state.liveStartedAt;
    const operation = active?.kind || (state.busy && !state.externalBusy ? 'working' : '');
    activityDetailEl.hidden = !operation;
    activityOperationEl.textContent = operation
      ? `${operation}${startedAt !== null && startedAt !== undefined ? ' for ' + formatElapsed(Date.now() - startedAt) : ''}`
      : '';
    activityTargetEl.textContent = active?.text || '';
    activityTargetEl.title = active?.text || '';
    activityTargetEl.hidden = !active?.text;
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

  function markLiveStart(key, startedAt) {
    const next = key || 'action';
    // A new action restarts the clock; updates of the same tool keep it.
    if (!state.liveStartedAt || state.liveKey !== next) {
      state.liveStartedAt = startedAt ?? Date.now();
      state.liveKey = next;
    }
    if (state.busy || state.attentionRequests.size) startLiveClock();
    renderLiveElapsed();
  }

  function setLiveAction(kind, text, key, summary, target, startedAt) {
    state.currentAction = { kind, text, summary, target };
    markLiveStart(key, startedAt);
  }

  function syncLiveFallback() {
    if (state.busy && !state.externalBusy && !state.currentAction) {
      markLiveStart('working');
    }
    if (state.busy || state.attentionRequests.size) startLiveClock();
    else stopLiveClock();
    renderLiveElapsed();
  }

  function clearLiveAction() {
    state.currentAction = null;
    state.liveToolId = null;
    state.liveStartedAt = null;
    state.liveKey = null;
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

  function toolFilePaths(card) {
    const update = card.activity || {};
    const input = toolInputObject(update) || {};
    let paths = permissionPatchOperations(input).map((operation) => operation.path);
    if (!paths.length) paths = (Array.isArray(update.content) ? update.content : [])
      .filter((item) => item?.type === 'diff').map((item) => item.path);
    if (!paths.length) paths = [input.filePath || input.path];
    if (!paths.some((path) => typeof path === 'string' && path.trim())) {
      paths = (Array.isArray(update.locations) ? update.locations : []).map((location) => location?.path);
    }
    return paths.filter((path) => typeof path === 'string' && path.trim()).map(permissionPathKey);
  }

  function summarizeTools(cards) {
    const files = { read: new Set(), edit: new Set(), write: new Set() };
    const calls = { read: 0, edit: 0, write: 0, execute: 0, search: 0, fetch: 0 };
    const unknownPaths = new Set();
    let failed = 0;
    for (const card of cards) {
      if (card.statusValue === 'failed') failed += 1;
      // Completed actions describe results; pending/failed actions are not successes.
      if (card.statusValue !== 'completed' || !Object.hasOwn(calls, card.kind)) continue;
      calls[card.kind] += 1;
      if (files[card.kind]) {
        const paths = toolFilePaths(card);
        if (!paths.length) unknownPaths.add(card.kind);
        for (const path of paths) files[card.kind].add(path);
      }
    }
    const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
    const metrics = [];
    for (const [kind, verb] of [['read', 'Read'], ['edit', 'Edited'], ['write', 'Wrote']]) {
      if (!calls[kind]) continue;
      metrics.push(`${verb} ${unknownPaths.has(kind) ? plural(calls[kind], 'time') : plural(files[kind].size, 'file')}`);
    }
    if (calls.execute) metrics.push(`Ran ${plural(calls.execute, 'command')}`);
    if (calls.search) metrics.push(`Searched ${plural(calls.search, 'time')}`);
    if (calls.fetch) metrics.push(`Fetched ${plural(calls.fetch, 'resource')}`);
    if (failed) metrics.push(`${failed} failed`);
    const running = cards.some((card) => card.statusValue === 'pending' || card.statusValue === 'in_progress');
    return { label: cards.length ? `${running ? 'Executing' : 'Executed'} ${plural(cards.length, 'tool')}` : 'Details', metrics };
  }

  function turnToolCards(details) {
    return [...details.querySelectorAll('.tool-entry')]
      .map((entry) => state.toolCards.get(entry.dataset.toolCallId)).filter(Boolean);
  }

  function renderStepSummary(title, meta, cards, count = cards.length) {
    const summary = summarizeTools(cards);
    title.textContent = `${count} step${count === 1 ? '' : 's'}`;
    meta.classList.add('step-metrics');
    const metrics = cards.length ? [summary.label, ...summary.metrics] : [];
    meta.replaceChildren(...metrics.map((text) => el('span', 'step-metric', text)));
  }

  function syncTurnSteps() {
    const steps = state.turnSteps;
    if (!steps) return;
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
    renderStepSummary(steps.titleEl, steps.metaEl, turnToolCards(steps.details), countBlockSteps(steps.details));
    steps.tokensEl.textContent = totalTokens ? formatTokens(totalTokens) : '';
    steps.tokensEl.title = totalTokens
      ? 'Estimated tokens for this turn'
      : '';
  }

  function finalizeTurnSteps() {
    const steps = state.turnSteps;
    if (!steps) return;
    syncTurnSteps();
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
    const totalTokens = Number(stat.tokens) || 0;
    // Preserve the original step total; the adjacent theses describe only tools.
    if (titleEl && metaEl) renderStepSummary(titleEl, metaEl, turnToolCards(details),
      Number(stat.steps) || countBlockSteps(details));
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
    // A failed prompt does not mean the transport disconnected: allow a retry.
    state.statusKind = 'error';
    state.statusText = text;
    state.busy = false;
    state.activityPlan = '';
    state.activityThought = '';
    state.activityPurpose = '';
    state.attentionRequests.clear();
    clearLiveAction();
    updateComposer();
    scrollToBottom();
  }

  function formatMessageTime(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const day = date.toDateString() === today.toDateString() ? 'today'
      : date.toDateString() === yesterday.toDateString() ? 'yesterday'
        : date.toLocaleDateString();
    return `${day} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}`;
  }

  function setMessageTime(wrap, timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) return;
    let time = wrap.querySelector(':scope > .message-time');
    if (!time) {
      time = el('time', 'message-time');
      wrap.prepend(time);
    }
    time.dataset.timestamp = String(timestamp);
    time.dateTime = new Date(timestamp).toISOString();
    time.textContent = formatMessageTime(timestamp);
    time.title = new Date(timestamp).toLocaleString(undefined, { hourCycle: 'h23' });
  }

  function stampMessage(wrap, messageId, timestamp) {
    if (messageId) wrap.dataset.messageId = messageId;
    setMessageTime(wrap, state.messageTimes.get(messageId) || timestamp || (state.replaying ? 0 : Date.now()));
  }

  function updateMessageTimes(times) {
    for (const { id, timestamp } of times || []) {
      if (id && Number.isFinite(timestamp) && timestamp > 0) state.messageTimes.set(id, timestamp);
    }
    for (const wrap of messagesEl.querySelectorAll('.message[data-message-id]')) {
      setMessageTime(wrap, state.messageTimes.get(wrap.dataset.messageId));
    }
  }

  // Relative day labels must also change in tabs left open overnight.
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

  function addUserMessage(text, messageId, images, timestamp) {
    finalizeThought();
    finalizeAssistant();
    finalizeToolGroup();
    finalizeTurnSteps();
    hideEmpty();

    if (messageId && state.lastUser && state.lastUser.messageId === messageId) {
      state.lastUser.text += text;
      const visible = OpenCodeRichText.visiblePrompt(state.lastUser.text);
      state.lastUser.body.textContent = visible;
      state.lastUser.body.hidden = !visible;
      addUserImages(state.lastUser.wrap, images, messageId);
      scrollToBottom();
      return;
    }

    // A user message starts a new turn.
    beginTurn();

    const wrap = el('div', 'message user');
    const visible = OpenCodeRichText.visiblePrompt(text);
    const body = el('div', 'body', visible);
    body.hidden = !visible;
    wrap.appendChild(body);
    addUserImages(wrap, images, messageId);
    stampMessage(wrap, messageId, timestamp);
    messagesEl.appendChild(wrap);
    state.userMessageCount += 1;
    state.lastUser = { messageId: messageId || null, wrap, body, text };
    scrollToBottom();
  }

  function addUserImages(wrap, images, messageId) {
    if (!Array.isArray(images) || !images.length) return;
    const gallery = el('div', 'user-images');
    for (const image of images) {
      const figure = el('figure');
      const thumb = el('img');
      thumb.src = image.dataUrl;
      thumb.alt = image.name || 'image';
      thumb.addEventListener('load', scrollToBottom);
      figure.appendChild(thumb);
      artifacts.offer({ id: `image-${++state.artifactSeq}`, title: image.name || 'Image', kind: 'image', dataUrl: image.dataUrl, origin: { messageId } }, figure);
      gallery.appendChild(figure);
    }
    wrap.appendChild(gallery);
  }

  function createAssistant(messageId) {
    const wrap = el('div', 'message assistant');
    wrap.hidden = true;
    const body = el('div', 'body');
    wrap.appendChild(body);
    stampMessage(wrap, messageId);
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
    assistant.text += content.text;
    state.liveToolId = null;
    setLiveAction('write', '', 'response:' + state.turnId, 'Writing response…', assistant.wrap);
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
      OpenCodeRichText.outline(assistant.body);
      OpenCodeRichText.hydrate(assistant.body, scrollToBottom);
      artifacts.ingest(assistant.body);
      for (const block of assistant.body.querySelectorAll('.diagram')) {
        artifacts.offer({ id: `diagram-${++state.artifactSeq}`, title: 'Diagram', kind: 'mermaid', content: block.querySelector('.visual-source-panel code').textContent, origin: { messageId: assistant.messageId } }, block);
      }
      scheduleFileChecks();
      // The answer is printed outside the chevron: close the block that holds
      // the steps before it, so later steps open a new one below the text.
      state.turnHadText = true;
      finalizeTurnSteps();
      scrollToBottom();
    }
    state.currentAssistant = null;
  }

  const thoughtLayouts = new WeakMap();
  const thoughtMeasure = typeof ResizeObserver === 'function' ? document.createElement('canvas').getContext('2d') : null;
  const thoughtResize = thoughtMeasure ? new ResizeObserver((entries) => {
    for (const { target } of entries) syncThoughtLayout(thoughtLayouts.get(target));
  }) : null;

  function syncThoughtLayout(thought) {
    if (!thought || !thoughtMeasure || !thought.details.clientWidth) return;
    const text = thought.text.trim();
    const singleLine = text && !/[\r\n]/.test(text);
    const heading = singleLine && /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(text);
    const bold = singleLine && /^(?:\*\*([^*]+)\*\*|__([^_]+)__)$/.exec(text);
    const label = heading?.[1] || bold?.[1] || bold?.[2] || text;
    thoughtMeasure.font = getComputedStyle(thought.body).font;
    const compact = Boolean(singleLine && thoughtMeasure.measureText(label).width <= thought.details.clientWidth - 16);
    if (compact !== thought.compact) {
      if (compact) thought.expanded = thought.details.open;
      thought.details.open = compact || thought.expanded;
      thought.details.classList.toggle('compact', compact);
      thought.compact = compact;
    }
    thought.body.textContent = compact ? label : thought.text;
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
      compact: false,
      expanded: false,
      captionOffset: 0,
      captionFence: '',
      caption: '',
    };
    state.currentThought = thought;
    thoughtLayouts.set(details, thought);
    thoughtResize?.observe(details);
    return thought;
  }

  function addThoughtChunk(content, messageId) {
    if (!content || content.type !== 'text' || typeof content.text !== 'string' || !content.text) {
      return;
    }
    finalizeToolGroup();
    hideEmpty();
    let thought = state.currentThought;
    if (thought && messageId && thought.messageId && messageId !== thought.messageId) {
      finalizeThought();
      thought = null;
    }
    if (!thought) {
      thought = createThought(messageId);
    }
    thought.text += content.text;
    updateThoughtCaption(thought, false);
    thought.body.textContent = thought.text;
    syncThoughtLayout(thought);
    thought.tokens = estimateTokens(thought.text);
    thought.tokensEl.textContent = formatTokens(thought.tokens);
    thought.tokensEl.title = 'Estimated from streamed content';
    thought.details.dataset.tokens = String(thought.tokens);
    state.liveToolId = null;
    setLiveAction('think', '', 'thought:' + state.turnId, 'Thinking…', thought.details);
    syncTurnSteps();
    scrollToBottom();
  }

  function finalizeThought() {
    const thought = state.currentThought;
    if (!thought) return;
    updateThoughtCaption(thought, true);
    thought.details.classList.remove('streaming');
    thought.details.open = thought.compact;
    thought.expanded = false;
    thought.labelEl.textContent = 'Thoughts';
    syncThoughtLayout(thought);
    state.currentThought = null;
    renderLiveElapsed();
  }

  function shortActivityCaption(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim().replace(/`([^`\r\n]+)`/g, '$1');
    // Do not turn a prefix of a reasoning stream into an apparent summary.
    if (!text || text.length > 120 || /[\r\n]/.test(text)) return '';
    if (/^(analysis|reasoning|thoughts?|thinking|plan|summary|working|read|edit|write|run|execute|search|fetch|shell|bash|patch|tool|other)[\s.!:…]*$/i.test(text)) return '';
    return text;
  }

  function updateThoughtCaption(thought, finished) {
    let caption = '';
    // Scan only newly completed lines, not the entire reasoning on every token.
    while (thought.captionOffset < thought.text.length) {
      const newline = thought.text.indexOf('\n', thought.captionOffset);
      if (newline < 0 && !finished) break;
      const end = newline < 0 ? thought.text.length : newline;
      const line = thought.text.slice(thought.captionOffset, end).replace(/\r$/, '');
      thought.captionOffset = newline < 0 ? end : end + 1;
      const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (!thought.captionFence) thought.captionFence = fence[1];
        else if (fence[1][0] === thought.captionFence[0] && fence[1].length >= thought.captionFence.length && !fence[2].trim()) thought.captionFence = '';
        continue;
      }
      if (thought.captionFence || /^( {4}|\t)/.test(line)) continue;
      const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      const bold = /^\s*(?:\*\*([^*]+)\*\*|__([^_]+)__):?\s*$/.exec(line);
      const candidate = shortActivityCaption(heading?.[1] || bold?.[1] || bold?.[2]);
      if (candidate) thought.caption = caption = candidate;
    }
    // Plain text is eligible only once the complete block is known to be short.
    if (finished && !thought.caption && !/^(?:\s*[#>*_`~]| {4}|\t)/.test(thought.text)) {
      caption = shortActivityCaption(thought.text);
    }
    if (caption && state.busy) state.activityThought = caption;
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
      const summary = summarizeTools(group.cards);
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
    const group = createToolGroup();
    const entry = el('div', subagent ? 'tool-entry subagent-entry' : 'tool-entry');
    entry.dataset.toolCallId = update.toolCallId;
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
    state.toolCards.set(update.toolCallId, card);
    for (const review of state.smartReviews.values()) {
      if (smartReviewTool(review.review) === card) placeSmartReview(review);
    }
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
    if (card.rows.output && (Array.isArray(update.content) || update.rawOutput !== undefined)) {
      card.outputText = toolContentText(update);
      card.rows.output.row.hidden = !OpenCodeRichText.renderToolResult(
        card.rows.output.contentEl, update, (message) => vscode.postMessage(message)
      );
      const diffItems = (update.content || []).filter((item) => item?.type === 'diff' && typeof item.newText === 'string');
      for (const [index, block] of [...card.rows.output.contentEl.querySelectorAll('.tool-diff')].entries()) {
        artifacts.offer({ ...diffItems[index], id: `diff-${++state.artifactSeq}`, title: diffItems[index].path || 'Diff', kind: 'diff', origin: { toolCallId: update.toolCallId } }, block);
      }
      for (const block of card.rows.output.contentEl.querySelectorAll('.tool-image')) {
        artifacts.offer({ id: `image-${++state.artifactSeq}`, title: 'Tool image', kind: 'image', dataUrl: block.querySelector('img').src, origin: { toolCallId: update.toolCallId } }, block);
      }
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
      card.activityTurn = state.turnId;
    }
    // Tool updates are partial. Keep the description and start time across them.
    card.activity = { ...card.activity, ...update };
    if (card.startedAt === undefined) card.startedAt = Date.now();
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
    restorePermissionRejection(card);
    if (!card.subagent) {
      card.body.hidden = !Object.values(card.rows).some((row) => !row.row.hidden);
    }
    syncToolGroup(card.group);
    syncTurnSteps();
    if (card.statusValue === 'pending' || card.statusValue === 'in_progress') {
      showToolActivity(card);
    } else if (state.liveToolId === update.toolCallId) {
      const running = [...state.toolCards.values()].reverse().find((item) =>
        item.activityTurn === state.turnId && (item.statusValue === 'pending' || item.statusValue === 'in_progress'));
      if (running) showToolActivity(running);
      else clearLiveAction();
    }
    scrollToBottom();
  }

  function showToolActivity(card) {
    const update = card.activity;
    state.liveToolId = update.toolCallId;
    const kind = actionLabel(card.kind);
    const text = card.subagent ? card.nameEl.textContent
      : kind === 'run' ? prefixLine(toolCommand(update)) : describeTool(update);
    const summary = toolActivityPurpose(card, text);
    if (summary && state.busy) state.activityPurpose = summary;
    setLiveAction(kind, text, update.toolCallId, summary, card.entry, card.startedAt);
  }

  function toolActivityPurpose(card, detail) {
    const input = toolInputObject(card.activity) || {};
    const normalize = (value) => String(value || '').replace(/[`'"…]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const targets = [detail, input.command, input.path, input.filePath, card.kind].map(normalize).filter(Boolean);
    for (const [index, value] of [input.description, card.nameEl.textContent].entries()) {
      const caption = shortActivityCaption(value);
      if (!caption || (index === 1 && !/\s/.test(caption))) continue;
      const normalized = normalize(caption);
      const withoutAction = normalized.replace(/^(?:read(?:ing)?|edit(?:ing)?|run(?:ning)?|execute|executing|write|writing|search(?:ing)?|fetch(?:ing)?|tool|shell|bash|patch)(?:\s+(?:file|command))?[\s:—-]+/, '');
      if (targets.some((target) => target === normalized || target === withoutAction)) continue;
      return caption;
    }
    return '';
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
    state.activityPlan = planEntries.find((entry) => entry.status === 'in_progress')?.content || '';
    syncLiveFallback();
    if (planProgress) {
      const done = planEntries.filter((entry) => entry.status === 'completed').length;
      const current = planEntries.find((entry) => entry.status === 'in_progress') || planEntries.find((entry) => entry.status !== 'completed');
      planProgress.hidden = !planEntries.length;
      const meter = document.getElementById('plan-meter');
      meter.max = planEntries.length || 1;
      meter.value = done;
      const text = `${done}/${planEntries.length} · ${current?.content || 'Plan complete'}`;
      document.getElementById('plan-progress-text').textContent = text;
      planProgress.title = text;
    }
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

  function permissionPatchOperations(input) {
    const text = input?.patchText;
    if (typeof text !== 'string') return [];
    const lines = text.trim().split(/\r?\n/);
    if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return [];
    const operations = [];
    let current;
    for (const line of lines.slice(1, -1)) {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
      if (header) {
        current = { action: { Add: 'Create', Update: 'Change', Delete: 'Delete' }[header[1]], path: header[2] };
        operations.push(current);
      } else if (line.startsWith('*** Move to: ') && current?.action === 'Change') {
        current.to = line.slice('*** Move to: '.length);
        current.action = 'Rename';
      }
    }
    return operations;
  }

  function permissionPathKey(file) {
    const text = file.replace(/\\/g, '/');
    const absolute = /^(?:\/|[a-z]:\/)/i.test(text) ? text : `${state.cwd || ''}/${text}`;
    const parts = [];
    for (const part of absolute.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    const key = parts.join('/');
    return /^[a-z]:\//i.test(absolute) ? key.toLowerCase() : key;
  }

  function renderPermissionDetails(card, toolCall) {
    const update = toolCall || {};
    const input = toolInputObject(update);
    const content = Array.isArray(update.content) ? update.content : [];
    const diffs = content.filter((item) => item?.type === 'diff' && typeof item.newText === 'string');
    const operation = { read: 'Read files', edit: 'Edit files', delete: 'Delete files',
      move: 'Move files', search: 'Search', execute: 'Run command', fetch: 'Fetch URL' }[update.kind];
    if (operation || update.name) {
      card.appendChild(el('div', 'permission-operation', [operation, update.name].filter(Boolean).join(' · ')));
    }

    const files = new Map();
    for (const location of Array.isArray(update.locations) ? update.locations : []) {
      if (typeof location?.path === 'string') files.set(location.path, { line: location.line });
    }
    for (const diff of diffs) {
      if (typeof diff.path !== 'string') continue;
      const info = files.get(diff.path) || {};
      files.set(diff.path, { ...info, diffs: [...(info.diffs || []), diff], action: diff.oldText === null ? 'Create' :
        diff.newText === '' ? 'Remove contents' : 'Change' });
    }
    const inputPath = input?.filePath || input?.path;
    if (!files.size && typeof inputPath === 'string') files.set(inputPath, {});
    // ACP includes both rename locations but usually attaches the diff only to
    // the destination. Pair them using explicit patch headers, not text similarity.
    const findPath = (value) => [...files.keys()].find((file) => permissionPathKey(file) === permissionPathKey(value));
    for (const operation of permissionPatchOperations(input)) {
      const source = findPath(operation.path);
      const target = operation.to ? findPath(operation.to) : source;
      if (!target) continue;
      const info = files.get(target);
      if (operation.to) {
        const previous = source && source !== target ? files.get(source) : null;
        files.set(target, { ...info, from: source || operation.path, action: 'Rename',
          diffs: [...(previous?.diffs || []), ...(info.diffs || [])] });
        if (source && source !== target) files.delete(source);
      } else files.set(target, { ...info, action: operation.action });
    }
    if (files.size) {
      const list = el('ul', 'permission-files');
      for (const [path, info] of files) {
        const item = el('li');
        const line = Number(info.line) || null;
        const label = info.from ? `${info.from} → ${path}` : line ? `${path}:${line}` : path;
        const link = el('span', 'file-ref', info.diffs?.length ? info.from ? 'Open source file' : 'Open file' : label);
        link.dataset.file = info.from || path;
        if (line) link.dataset.line = String(line);
        if (info.diffs?.length) {
          const details = el('details', 'permission-file');
          details.open = files.size === 1;
          const summary = el('summary');
          if (info.action) summary.appendChild(el('span', 'permission-file-action', info.action + ' · '));
          summary.appendChild(el('span', 'permission-file-path', label));
          const preview = el('div', 'permission-preview');
          OpenCodeRichText.renderToolResult(preview, { content: info.diffs }, (message) => vscode.postMessage(message));
          const toolbar = preview.querySelector('.result-toolbar');
          if (toolbar) toolbar.prepend(link);
          details.append(summary, preview);
          item.appendChild(details);
        } else {
          if (info.action) item.appendChild(el('span', 'permission-file-action', info.action + ' · '));
          item.appendChild(link);
        }
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    if (typeof input?.command === 'string') {
      card.appendChild(el('pre', 'permission-command', input.command));
      const cwd = input.workdir || input.cwd;
      if (typeof cwd === 'string') card.appendChild(el('div', 'permission-directory', 'Working directory: ' + cwd));
    }
    const otherContent = content.filter((item) => !diffs.includes(item) || typeof item.path !== 'string');
    if (otherContent.length) {
      const preview = el('div', 'permission-preview');
      OpenCodeRichText.renderToolResult(preview, { content: otherContent }, (message) => vscode.postMessage(message));
      card.appendChild(preview);
    }
    if (!diffs.length && (['edit', 'delete', 'move'].includes(update.kind) || !content.length && !input)) {
      card.appendChild(el('div', 'permission-note', 'No change preview was provided by OpenCode.'));
    }
    const raw = toolInputText(update);
    if (raw) {
      const details = el('details', 'permission-input');
      details.open = !content.length && typeof input?.command !== 'string';
      details.appendChild(el('summary', '', 'Operation arguments'));
      details.appendChild(el('pre', '', raw));
      card.appendChild(details);
    }
  }

  function permissionBusy(card, busy) {
    card.dataset.busy = busy ? '1' : '0';
    for (const control of card.querySelectorAll('.permission-actions button, .permission-remember button, .permission-remember select')) {
      control.disabled = busy;
    }
  }

  function renderRememberRule(card, message) {
    let holder = card.querySelector('.permission-remember');
    if (!holder) { holder = el('div', 'permission-remember'); card.appendChild(holder); }
    holder.replaceChildren();
    const policy = message.policy;
    if (!policy) return;
    if (!policy.choices?.length) {
      holder.appendChild(el('div', 'permission-note', 'No precise saved rule is available for this request.'));
      return;
    }
    const details = el('details');
    details.appendChild(el('summary', '', 'Save rule…'));
    details.appendChild(el('div', 'permission-note', `All sessions in this project · ${policy.profileLabel}`));
    const choice = document.createElement('select');
    choice.setAttribute('aria-label', 'Rule target');
    for (const item of policy.choices) {
      const option = el('option', '', item.label);
      option.value = item.id;
      choice.appendChild(option);
    }
    const effect = document.createElement('select');
    effect.setAttribute('aria-label', 'Rule decision');
    for (const [value, label] of [['allow', 'Allow'], ['deny', 'Forbid']]) {
      const option = el('option', '', label);
      option.value = value;
      effect.appendChild(option);
    }
    const preview = el('pre', 'permission-rule-preview');
    const update = () => {
      const selected = policy.choices.find((item) => item.id === choice.value);
      preview.textContent = (selected?.rules || []).map((rule) =>
        `${effect.value === 'allow' ? 'Allow' : 'Forbid'} ${rule.action} · ${rule.resource} (${rule.match || 'glob'})`).join('\n');
    };
    choice.addEventListener('change', update);
    effect.addEventListener('change', update);
    update();
    const save = el('button', '', 'Save and apply');
    save.addEventListener('click', () => {
      if (card.dataset.resolved === '1' || card.dataset.busy === '1') return;
      card.querySelector('.permission-save-status')?.remove();
      permissionBusy(card, true);
      vscode.postMessage({ type: 'savePermissionRule', requestId: message.requestId,
        choiceId: choice.value, effect: effect.value });
    });
    details.append(effect, choice, preview, save);
    holder.appendChild(details);
  }

  function permissionRuleResult(message) {
    const card = [...messagesEl.querySelectorAll('.permission[data-request-id]')]
      .find((item) => item.dataset.requestId === String(message.requestId));
    if (!card || card.dataset.resolved === '1') return;
    card.querySelector('.permission-save-status')?.remove();
    if (message.error) {
      if (message.policy) {
        renderRememberRule(card, message);
        const reason = card.querySelector('.permission-reason');
        if (reason) reason.textContent = message.policy.reason;
      }
      permissionBusy(card, false);
    } else {
      card.dataset.resolved = '1';
      permissionBusy(card, true);
      resolveAttention(card);
    }
    const status = el('div', 'permission-note permission-save-status', message.error || message.note);
    status.setAttribute('role', message.error ? 'alert' : 'status');
    card.appendChild(status);
  }

  function addPermission(message) {
    for (const card of messagesEl.querySelectorAll('.permission[data-request-id]')) {
      if (card.dataset.requestId !== String(message.requestId)) continue;
      resolveAttention(card);
      card.remove();
    }
    hideEmpty();
    finalizeAssistant();
    finalizeThought();
    finalizeToolGroup();
    finalizeTurnSteps();

    const card = el('div', 'permission');
    card.dataset.requestId = String(message.requestId);
    card.appendChild(el('div', 'permission-title', 'Permission required'));
    if (message.policy?.reason) card.appendChild(el('div', 'permission-reason', message.policy.reason));
    card.appendChild(el('div', 'permission-tool', toolTitle(message.toolCall)));
    renderPermissionDetails(card, message.toolCall);
    const actions = el('div', 'permission-actions');
    const options = Array.isArray(message.options) ? message.options : [];

    for (const option of options) {
      const allow = /^(allow|approve)/i.test(String(option.kind || '')) || /allow|approve/i.test(String(option.name || ''));
      const button = el('button', allow ? 'allow' : 'reject', option.name || option.optionId);
      button.addEventListener('click', () => {
        if (card.dataset.resolved === '1' || card.dataset.busy === '1') return;
        card.dataset.resolved = '1';
        permissionBusy(card, true);
        resolveAttention(card);
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
        if (card.dataset.resolved === '1' || card.dataset.busy === '1') return;
        card.dataset.resolved = '1';
        permissionBusy(card, true);
        resolveAttention(card);
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
    renderRememberRule(card, message);
    messagesEl.appendChild(card);
    requestAttention(card, 'permission', 'Waiting for approval', toolTitle(message.toolCall));
    scheduleFileChecks();
    scrollToBottom();
  }

  function restorePermissionRejection(card) {
    // ACP preserves the error message in both live updates and history replay,
    // but drops its native permission.rejected type and Smart provenance.
    const error = card.activity.rawOutput?.error;
    const match = typeof error === 'string' && /^VS Code permissions: deny(?: — ([\s\S]*))?$/.exec(error);
    if (card.statusValue !== 'failed' || !match) return;
    addSmartReview({
      id: `restored:${state.sessionId}:${card.activity.toolCallId}`,
      sessionID: state.sessionId,
      toolCallId: card.activity.toolCallId,
      restored: true,
      status: 'deny',
      resource: card.nameEl.textContent,
      reason: match[1] || error,
    });
  }

  function smartReviewTool(review) {
    if (typeof review.toolCallId !== 'string' || !review.toolCallId) return null;
    if (!review.sessionID) return state.toolCards.get(review.toolCallId);
    const prefix = review.sessionID + ':';
    const id = review.toolCallId.startsWith(prefix) ? review.toolCallId.slice(prefix.length) : review.toolCallId;
    // ACP qualifies forwarded child calls. Never bind a child's native ID to a parent call.
    return state.toolCards.get(prefix + id) ||
      (review.sessionID === state.sessionId ? state.toolCards.get(id) : null);
  }

  function placeSmartReview(record) {
    const tool = smartReviewTool(record.review);
    if (tool) {
      for (const other of state.smartReviews.values()) {
        if (other === record || smartReviewTool(other.review) !== tool) continue;
        // A saved denial supersedes a stale pending poll. A completed Smart
        // denial supplies richer provenance and replaces the restored fallback.
        if ((record.review.restored && !other.review.restored && other.review.status === 'deny') ||
            (record.review.status === 'reviewing' && other.review.restored)) {
          record.card.remove();
          return;
        }
        if ((record.review.restored && other.review.status === 'reviewing') ||
            (!record.review.restored && record.review.status === 'deny' && other.review.restored)) {
          other.card.remove();
        }
      }
      if (record.card.parentElement !== tool.entry) tool.entry.insertBefore(record.card, tool.body);
      const history = state.smartReviewHistory;
      if (history && !history.body.children.length) {
        history.details.remove();
        state.smartReviewHistory = null;
      }
      return;
    }
    if (record.review.restored) {
      record.card.remove();
      return;
    }
    // Old records may lack an ID; a denied call may never appear in replay.
    // Preserve these decisions without guessing a step from command text or timing.
    if (!state.smartReviewHistory) {
      const details = el('details', 'smart-review-history');
      details.appendChild(el('summary', '', 'Unlinked Smart permissions'));
      const body = el('div', 'body');
      details.appendChild(body);
      messagesEl.appendChild(details);
      state.smartReviewHistory = { details, body };
    }
    if (record.card.parentElement !== state.smartReviewHistory.body) {
      state.smartReviewHistory.body.appendChild(record.card);
    }
  }

  function addSmartReview(review) {
    if (!review || !review.id) return;
    const previous = state.smartReviews.get(review.id);
    const signature = JSON.stringify(review);
    if (previous?.signature === signature) {
      placeSmartReview(previous);
      return;
    }
    hideEmpty();
    const card = previous?.card || el('div', 'permission smart-review');
    card.dataset.reviewId = review.id;
    card.setAttribute('role', 'status');
    card.dataset.status = review.status;
    card.replaceChildren();
    const status = { reviewing: 'Reviewing', allow: 'Allowed', deny: 'Blocked' }[review.status] || 'Blocked';
    card.appendChild(el('div', 'permission-title', review.restored
      ? `Permissions · ${status}` : `Smart · ${status} · permission-classifier`));
    card.appendChild(el('div', 'permission-tool', review.restored ? review.resource : `${review.action}: ${review.resource}`));
    if (review.reason) card.appendChild(el('div', 'permission-note', review.reason));
    card.title = review.model ? `Reviewer model: ${review.model}` : '';
    const record = { card, signature, review };
    state.smartReviews.set(review.id, record);
    placeSmartReview(record);
    scrollToBottom();
  }

  function syncQuestions() {
    const cards = [...questionsEl.querySelectorAll('.elicitation')];
    cards.forEach((card, index) => { card.hidden = index !== 0; });
    questionsEl.hidden = cards.length === 0;
    composerEl.classList.toggle('question-active', cards.length > 0);
    updateComposer();
  }

  function addElicitation(message) {
    if (state.archived) return;
    for (const card of questionsEl.querySelectorAll('.elicitation[data-request-id]')) {
      if (card.dataset.requestId !== String(message.requestId)) continue;
      resolveAttention(card);
      card.remove();
    }
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
    card.dataset.requestId = String(message.requestId);
    if (typeof message.message === 'string' && message.message && !/^questions?$/i.test(message.message.trim())) {
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
      resolveAttention(card);
      const payload = { type: 'elicitationResponse', requestId: message.requestId, action };
      if (action === 'accept') payload.content = collectElicitationContent(controls);
      vscode.postMessage(payload);
      card.remove();
      syncQuestions();
    }

    actions.appendChild(submit);
    actions.appendChild(cancel);
    card.appendChild(actions);
    questionsEl.appendChild(card);
    syncQuestions();
    requestAttention(card, 'question', 'Waiting for your answer', prefixLine(message.message || 'Question'));
    if (!card.hidden) card.querySelector('input, button.allow')?.focus();
  }

  function buildElicitationField(name, prop, required, controls, limits) {
    if (!prop || typeof prop !== 'object') return null;
    const type = prop.type;
    const isRequired = required.indexOf(name) !== -1;
    const custom = name.endsWith('_custom');
    const choices = type === 'string' ? elicitationChoices(prop)
      : type === 'array' ? elicitationChoices(prop.items) : [];
    const question = choices.length > 0 && typeof prop.description === 'string' && prop.description.trim();
    const label = custom ? 'Custom answer' : question || prop.title || name;

    const row = el('div', 'elicitation-field');
    const labelEl = el('label', question ? 'elicitation-label elicitation-question' : 'elicitation-label',
      isRequired ? label + ' *' : label);
    row.appendChild(labelEl);

    if (
      type === 'string' &&
      (Array.isArray(prop.enum) || Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf))
    ) {
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

    if (prop.description && !question && !custom) {
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
      if (multiple) {
        optionRow.appendChild(input);
      } else {
        const control = el('span', 'elicitation-radio');
        control.appendChild(input);
        optionRow.appendChild(control);
      }
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
    const window = Number(limit.input) || context;
    const prompt = cache && Number(cache.prompt) > 0 ? Number(cache.prompt) : 0;
    const used = prompt > 0 ? prompt : usage && typeof usage.used === 'number' ? usage.used : null;
    const parts = [
      `context: ${used === null ? '—' : formatCompact(used)}` +
        (window > 0 ? ` / ${formatCompact(window)}` : '') +
        cacheSuffix(cache),
    ];
    const threshold = compactionThreshold(context, limit.input);
    if (threshold > 0) {
      parts.push(`compaction at ${formatCompact(threshold)}`);
    }
    usageEl.textContent = parts.join(' · ');

    const subscription = limit.subscription === true;
    if (usageSubscriptionEl) usageSubscriptionEl.hidden = !subscription;
    const cost = usage && usage.cost;
    const currency = (cost && cost.currency) || 'USD';
    const parentCost = cost && typeof cost.amount === 'number' ? cost.amount : 0;
    const subagentCost = Number(state.subagentCost) || 0;
    let costText = '';
    if (cost && typeof cost.amount === 'number' && (!subscription || parentCost + subagentCost > 0)) {
      costText = `cost: ${formatCost(parentCost + subagentCost, currency)}`;
      if (subagentCost > 0) {
        costText += ` (sub-agents ${formatCost(subagentCost, currency)})`;
      }
    } else if (subagentCost > 0) {
      costText = `cost: ${formatCost(subagentCost, currency)} (sub-agents)`;
    }
    const budget = subscription ? null : state.budget;
    if (budget && typeof budget.remaining === 'number') {
      const suffix =
        budget.modelMatched && budget.label ? ` for ${budget.label}` : '';
      costText +=
        (costText ? ' · ' : '') + `$${budget.remaining.toFixed(2)} left${suffix}`;
    }
    const balance = subscription ? null : state.balance;
    if (balance && typeof balance.amount === 'number') {
      costText +=
        (costText ? ' · ' : '') +
        `balance: ${formatMoney(balance.amount, balance.currency)}`;
    }
    usageCostEl.textContent = costText;
    usageCostEl.hidden = !costText;
    usageCostEl.title = costTooltip(state.costSplit, subagentCost);

    const resetAt = subscription ? 0 : nextReset(state.limits, budget);
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
      return (number / 1000000).toFixed(number >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    }
    if (number >= 1000) {
      // Keep one decimal so 84200 reads as 84.2k, and drop a trailing .0.
      return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return String(number);
  }

  function isAgentOption(option) {
    return Boolean(option) && (option.id === 'mode' || option.id === 'agent' || option.category === 'mode');
  }

  function appendPermissionProfiles() {
    const current = state.permissionProfile;
    if (!current) return;
    const makeSelect = (caption, choices, value, field, disabled) => {
      const label = el('label', 'config');
      label.appendChild(el('span', null, caption));
      const select = document.createElement('select');
      select.setAttribute('aria-label', caption);
      for (const item of choices) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        option.selected = item.id === value;
        select.appendChild(option);
      }
      select.disabled = disabled || current.inherited;
      select.addEventListener('change', () => {
        for (const control of configBarEl.querySelectorAll('.permission-control')) control.disabled = true;
        vscode.postMessage({ type: 'setPermissionProfile', [field]: select.value });
      });
      select.className = 'permission-control';
      label.appendChild(select);
      configBarEl.appendChild(label);
      return select;
    };
    const profile = makeSelect('Profile', current.profiles, current.selected, 'profile', false);
    profile.title = `Layers: ${(current.layers || []).join(' → ')}. Explicit denies remain in force.` +
      (current.selected === 'host' ? ' Host currently has the same access as All; it does not isolate the network.' : '');
    const fallback = makeSelect('Without a rule', [
      { id: 'forbid', label: 'Forbid' }, { id: 'ask', label: 'Ask' },
      { id: 'smart', label: 'Smart' }, { id: 'permit', label: 'Permit' },
    ], current.newActions, 'newActions', current.fallbackLocked);
    fallback.title = current.fallbackLocked
      ? 'This profile already has a rule for every action.'
      : 'Only actions not matched by any profile rule. Saved for this session and profile.';
    const rules = el('button', 'permission-rules-link', 'Rules…');
    rules.title = current.rulesFile || 'Open project permission rules';
    rules.setAttribute('aria-label', 'Open permission rules');
    rules.addEventListener('click', () => vscode.postMessage({ type: 'openPermissionRules' }));
    configBarEl.appendChild(rules);
    if (current.inherited) configBarEl.appendChild(el('span', 'config', 'Inherited from parent'));
  }

  function appendFixedAgent(option) {
    const label = el('span', 'config');
    label.title = 'Agent fixed at session creation. Choose the agent for new sessions in the sidebar.';
    const selected = (option.options || []).find((item) => item.value === option.currentValue);
    label.appendChild(el('span', null, `Agent: ${selected?.name || option.currentValue || '—'}`));
    configBarEl.appendChild(label);
  }

  function appendEffortSlider(option) {
    if (option.options.length < 2) return;
    // Default is a mode, not the strongest level. Keep it at the start and
    // preserve the server's ordering of explicit (including custom) variants.
    const choices = [...option.options.filter((item) => item.value === 'default'),
      ...option.options.filter((item) => item.value !== 'default')];
    const label = el('label', 'config effort-control');
    label.appendChild(el('span', null, option.name || 'Effort'));
    const track = el('span', 'effort-track');
    const ticks = el('span', 'effort-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    for (const item of choices) ticks.appendChild(el('span', item.value === 'default' ? 'effort-default-tick' : ''));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(choices.length - 1);
    input.step = '1';
    input.value = String(Math.max(0, choices.findIndex((item) => item.value === option.currentValue)));
    input.dataset.configId = option.id;
    input.setAttribute('aria-label', option.name || 'Effort');
    const tooltip = el('span', 'effort-tooltip');
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    let dragging = false;
    let pending = false;
    const initial = input.value;
    const selected = () => choices[Number(input.value)];
    const update = () => input.setAttribute('aria-valuetext', selected().name || selected().value);
    const show = (index = Number(input.value)) => {
      const item = choices[index];
      tooltip.textContent = item.value === 'default' ? 'Default — model setting' : item.name || item.value;
      tooltip.hidden = false;
      const rect = input.getBoundingClientRect();
      const width = tooltip.getBoundingClientRect().width;
      const center = rect.left + 6 + (rect.width - 12) * index / (choices.length - 1);
      tooltip.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, center - width / 2))}px`;
      tooltip.style.top = `${Math.max(4, rect.top - tooltip.offsetHeight - 6)}px`;
    };
    const hide = () => { tooltip.hidden = true; };
    input.addEventListener('pointerdown', (event) => {
      if (pending) { event.preventDefault(); return; }
      if (event.button !== 0) return;
      dragging = true;
      input.setPointerCapture(event.pointerId);
      show();
    });
    input.addEventListener('pointermove', (event) => {
      if (dragging) { show(); return; }
      const rect = input.getBoundingClientRect();
      const index = Math.round((event.clientX - rect.left - 6) / (rect.width - 12) * (choices.length - 1));
      show(Math.max(0, Math.min(choices.length - 1, index)));
    });
    input.addEventListener('pointerup', () => {
      dragging = false;
      if (!input.matches(':hover')) hide();
    });
    input.addEventListener('pointercancel', () => {
      dragging = false;
      input.value = initial;
      update();
      hide();
    });
    input.addEventListener('pointerleave', () => { if (!dragging) hide(); });
    input.addEventListener('focus', () => show());
    input.addEventListener('blur', hide);
    input.addEventListener('keydown', (event) => {
      if (pending && event.key !== 'Tab') event.preventDefault();
    });
    input.addEventListener('input', () => { update(); show(); });
    input.addEventListener('change', () => {
      if (pending || input.value === initial) return;
      pending = true;
      // Keep focus while saving so the refreshed control can restore it.
      input.setAttribute('aria-disabled', 'true');
      vscode.postMessage({ type: 'setConfigOption', configId: option.id, value: selected().value });
    });
    update();
    track.append(ticks, input, tooltip);
    label.appendChild(track);
    configBarEl.appendChild(label);
  }

  function setConfigOptions(options) {
    state.configOptions = options;
    const restoreModelFocus = modelPicker?.containsFocus();
    const restoreEffortFocus = configBarEl.contains(document.activeElement)
      && document.activeElement.matches('input[type="range"]') ? document.activeElement.dataset.configId : null;
    modelPicker?.dispose();
    modelPicker = null;
    configBarEl.replaceChildren();
    const list = Array.isArray(options) ? options : [];
    for (const option of list) {
      if (!option) continue;
      if (isAgentOption(option)) {
        appendFixedAgent(option);
        continue;
      }
      if (option.type !== 'select' || !Array.isArray(option.options)) continue;
      if (option.category === 'model' || option.id === 'model') {
        modelPicker = OpenCodeModelPicker.create(option, (value) => vscode.postMessage({
          type: 'setConfigOption', configId: option.id, value,
        }));
        configBarEl.appendChild(modelPicker.element);
        continue;
      }
      if (option.id === 'effort' || option.category === 'thought_level') {
        appendEffortSlider(option);
        continue;
      }
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
    appendPermissionProfiles();
    configBarEl.hidden = configBarEl.children.length === 0;
    if (restoreModelFocus) modelPicker?.focus();
    if (restoreEffortFocus) {
      [...configBarEl.querySelectorAll('input[type="range"]')]
        .find((input) => input.dataset.configId === restoreEffortFocus)?.focus();
    }
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
          // An ACP prompt containing only synthetic continuation context has
          // an empty user input. Do not replay it as a blank user bubble.
          if (!update.content.text) break;
          addUserMessage(update.content.text, update.messageId || null);
        } else if (update.content?.type === 'image' && typeof update.content.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(update.content.mimeType)) {
          addUserMessage('', update.messageId || null, [{ name: 'Image', dataUrl: `data:${update.content.mimeType};base64,${update.content.data}` }]);
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

  const inputStatus = { sending: 'Sending…', queued: 'Queued', running: 'Running', completed: 'Completed',
    failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', unknown: 'Delivery unconfirmed' };

  function nativeImages(files) {
    return (files || []).flatMap((file) => {
      const uri = file.uri || (/^image\/(png|jpeg|gif|webp)$/.test(file.mime || '') && typeof file.data === 'string'
        ? `data:${file.mime};base64,${file.data}` : '');
      return /^data:image\/(png|jpeg|gif|webp);base64,/.test(uri) ? [{ dataUrl: uri, name: file.name }] : [];
    });
  }

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
    const text = inputStatus[status] || status;
    if (label.textContent !== text) label.textContent = text;
    const id = wrap.dataset.messageId;
    const canResend = ['unknown', 'failed', 'cancelled'].includes(status) && state.pendingInputs.get(id)?.item;
    wrap.title = canResend ? 'Message undelivered — click icon to resend.'
      : status === 'unknown' ? 'Message undelivered.' : text;
    for (const content of wrap.querySelectorAll('.body, .user-images')) content.setAttribute('aria-describedby', label.id);
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
        indicator.addEventListener('click', () => resendSubmission(id));
      } else indicator.setAttribute('role', 'img');
      indicator.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        (canResend ? '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7"/>' : '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>') + '</svg>';
      target.classList.add('has-delivery-indicator');
      target.appendChild(indicator);
    }
  }

  function resendSubmission(id) {
    const entry = state.pendingInputs.get(id);
    if (!entry?.item || !['unknown', 'failed', 'cancelled'].includes(entry.state)) return;
    const item = entry.item;
    showSubmission({ id, state: 'sending', item });
    vscode.postMessage({ type: 'resend', item });
  }

  function showSubmission(submission) {
    if (!submission.id) return;
    const delivered = state.nativeUsers.get(submission.id);
    if (delivered) return; // An SSE snapshot may win the race with POST's response.
    let entry = state.pendingInputs.get(submission.id);
    if (!entry) {
      // Cancellation events can also refer to synthetic work with no user card.
      if (!submission.item) return;
      hideEmpty();
      const wrap = el('div', 'message user queued-input');
      wrap.dataset.anchorId = submission.id;
      wrap.dataset.messageId = submission.id;
      const payload = submission.item?.payload || {};
      wrap.appendChild(el('div', 'body', OpenCodeRichText.visiblePrompt(payload.text || '')));
      const images = nativeImages(payload.files);
      addUserImages(wrap, images, submission.id);
      stampMessage(wrap, submission.id, submission.item?.time?.created);
      messagesEl.appendChild(wrap);
      entry = { wrap, state: submission.state };
      state.pendingInputs.set(submission.id, entry);
    }
    entry.state = submission.state;
    entry.cancellationConfirmed = submission.state === 'cancelled';
    entry.item = submission.item || entry.item;
    setInputStatus(entry.wrap, submission.state);
    if (submission.error) entry.wrap.dataset.deliveryError = submission.error;
    placeSubmissions();
    saveSubmissions();
    scrollToBottom();
  }

  function saveSubmissions() {
    if (!state.sessionId) return;
    vscode.setState({ ...vscode.getState?.(), submissions: [...state.pendingInputs].map(([id, entry]) => ({
      id, state: entry.state, item: entry.item,
      cancellationConfirmed: entry.cancellationConfirmed,
    })) });
  }

  function reconcileSubmissions() {
    if (!state.nativeInbox) return;
    for (const [id, entry] of state.pendingInputs) {
      // Inbox absence is not a cancellation acknowledgement: delivery may race
      // the history read, or the item may have disappeared while disconnected.
      if (!state.nativeInbox.has(id) && entry.state === 'queued') {
        entry.state = 'unknown';
        setInputStatus(entry.wrap, entry.state);
      }
    }
  }

  function placeSubmissions() {
    const created = (entry) => entry.item?.time?.created ||
      Number(entry.wrap.querySelector('.message-time')?.dataset.timestamp) || Infinity;
    const users = [...state.nativeUsers].map(([id, wrap]) => ({ wrap, time: state.messageTimes.get(id) }));
    for (const entry of [...state.pendingInputs.values()].sort((a, b) => created(a) - created(b))) {
      // Keep an unresolved/cancelled input before later user turns. Appending
      // every saved card to the bottom reverses history as new turns arrive.
      const next = users.find((user) => user.time > created(entry));
      messagesEl.insertBefore(entry.wrap, next?.wrap || null);
    }
  }

  function renderTranscript(snapshot) {
    state.nativeTransport = true;
    const viewport = restoredViewport || captureViewport();
    // Suppress intermediate appends moving the viewport during a batch.
    state.autoScroll = false;
    for (const message of snapshot.messages || []) {
      const signature = JSON.stringify(message);
      if (state.nativeMessages.get(message.id) === signature) continue;
      state.nativeMessages.set(message.id, signature);
      const before = new Set(messagesEl.children);
      state.messageTimes.set(message.id, message.time?.streamed || message.time?.created);
      if (message.type === 'user' && !state.nativeUsers.has(message.id)) {
        state.pendingInputs.get(message.id)?.wrap.remove();
        state.pendingInputs.delete(message.id);
        addUserMessage(message.text || '', message.id, nativeImages(message.files), message.time?.created);
        state.nativeUsers.set(message.id, state.lastUser.wrap);
      } else if (message.type === 'assistant') {
        for (const [index, part] of (message.content || []).entries()) {
          const key = `${message.id}:${index}`;
          let record = state.nativeParts.get(key);
          if (part.type === 'tool') {
            const serialized = JSON.stringify(part.update);
            if (record?.serialized !== serialized) {
              upsertTool(part.update);
              state.nativeParts.set(key, { serialized });
            }
          } else if (part.type === 'text' && part.text) {
            if (!record) {
              addAssistantChunk({ type: 'text', text: part.text }, key);
              record = state.currentAssistant;
              state.nativeParts.set(key, record);
            }
            if (record.text !== part.text || record.wrap.hidden) {
              record.text = part.text;
              record.wrap.hidden = false;
              record.body.classList.add('md');
              record.body.innerHTML = renderMarkdown(record.text);
            }
            stampMessage(record.wrap, message.id, message.time?.streamed || message.time?.created);
            if (message.time?.completed && !record.nativeComplete) {
              record.nativeComplete = true;
              if (state.currentAssistant === record) finalizeAssistant();
              else { OpenCodeRichText.hydrate(record.body, scrollToBottom); artifacts.ingest(record.body); }
            }
          } else if (part.type === 'reasoning' && part.text) {
            if (!record) {
              addThoughtChunk({ type: 'text', text: part.text }, key);
              record = state.currentThought;
              state.nativeParts.set(key, record);
            } else if (record.text !== part.text) {
              record.text = part.text;
              record.body.textContent = part.text;
              updateThoughtCaption(record, Boolean(message.time?.completed));
              syncThoughtLayout(record);
            }
          }
        }
        if (message.time?.completed) {
          finalizeAssistant();
          finalizeThought();
        }
      } else if (message.type === 'idle') {
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        finalizeTurnSteps();
      }
      let index = 0;
      for (const node of messagesEl.children) {
        if (!before.has(node) && !node.dataset.anchorId) node.dataset.anchorId = `${message.id}:${index++}`;
      }
    }
    if (snapshot.partial) {
      placeSubmissions();
      restoreViewport(viewport);
      return;
    }
    for (const [id, status] of snapshot.states || []) {
      const wrap = state.nativeUsers.get(id);
      if (wrap) setInputStatus(wrap, status);
    }
    state.nativeInbox = new Set((snapshot.inbox || []).map((item) => item.id));
    reconcileSubmissions();
    for (const item of snapshot.inbox || []) {
      if (item.type !== 'user') continue;
      showSubmission({ id: item.id, item, state: item.submissionState || 'queued' });
    }
    // Delivery replaces the local card with the actual server-ordered message.
    placeSubmissions();
    restoreViewport(viewport);
    saveSubmissions();
    saveViewport();
  }

  function handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'status':
        setStatus(message.state, message.message, message.external);
        break;
      case 'session':
        setSession(message);
        for (const submission of restoredSubmissions) {
          if (state.pendingInputs.has(submission.id)) continue; // A fresh snapshot wins over cached state.
          // Older clients inferred cancellation from inbox absence. Only keep
          // it when an explicit server cancellation was recorded by this client.
          const unconfirmed = submission.state === 'sending' ||
            (submission.state === 'cancelled' && !submission.cancellationConfirmed);
          showSubmission({ ...submission, state: unconfirmed ? 'unknown' : submission.state });
        }
        restoredSubmissions = [];
        reconcileSubmissions();
        placeSubmissions();
        saveSubmissions();
        break;
      case 'capabilities':
        state.imageSupport = Boolean(message.images);
        state.nativeTransport = message.transport === 'server';
        break;
      case 'transcript':
        renderTranscript(message);
        break;
      case 'submission':
        showSubmission(message);
        break;
      case 'requestResolved':
        for (const card of [...messagesEl.querySelectorAll('.permission[data-request-id]'), ...questionsEl.querySelectorAll('.elicitation[data-request-id]')]) {
          if (card.dataset.requestId !== String(message.requestId)) continue;
          resolveAttention(card);
          card.remove();
        }
        syncQuestions();
        break;
      case 'slashItems':
        state.skills = Array.isArray(message.skills) ? message.skills : [];
        state.restCommands = Array.isArray(message.commands) ? message.commands : [];
        buildSlashItems();
        if (state.slashOpen) refreshSlashMenu();
        break;
      case 'historyReset':
        artifacts.reset();
        resetTranscript();
        break;
      case 'messageTimes':
        updateMessageTimes(message.times);
        break;
      case 'sessionInfo':
        setTitle(message.title);
        if (typeof message.archived === 'boolean') setArchived(message.archived);
        break;
      case 'focus':
        focusComposer(message.preserveScroll === true);
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
      case 'smartReviews':
        for (const review of message.reviews || []) addSmartReview(review);
        break;
      case 'permissionProfile':
        state.permissionProfile = message;
        setConfigOptions(state.configOptions || []);
        break;
      case 'permissionRuleResult':
        permissionRuleResult(message);
        break;
      case 'modelLimit':
        state.modelLimit = {
          context: Number(message.context) || 0,
          input: Number(message.input) || 0,
          subscription: message.subscription === true,
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
        state.replaying = false;
        state.skipUserIndex = -1;
        state.skipUserId = null;
        state.commandEchoText = '';
        finalizeAssistant();
        finalizeThought();
        finalizeToolGroup();
        finalizeTurnSteps();
        if (restoredViewport) {
          const viewport = restoredViewport;
          restoredViewport = null;
          restoreViewport(viewport);
          requestAnimationFrame(() => restoreViewport(viewport));
        } else if (state.autoScroll) jumpToBottom();
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
      if (!item.running && item.result) li.appendChild(el('div', 'subagent-result', item.result));
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

  function renderFileText(value) {
    return escapeHtml(value).replace(
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
    for (const node of (document.getElementById('workspace') || messagesEl).querySelectorAll('.file-ref')) {
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

  function renderMarkdown(source) {
    return OpenCodeRichText.render(source, {
      text: renderFileText,
      file: (target, label) => {
        const parts = fileLinkParts(escapeHtml(target));
        return parts ? fileToken(parts, label) : null;
      },
    });
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
  if (usageLinkEl) {
    usageLinkEl.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: 'https://chatgpt.com/settings/usage' });
    });
  }

  messagesEl.addEventListener('scroll', () => {
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    state.autoScroll = distance < 120;
    saveViewport();
  });

  function addCollapseControl(details) {
    if (details.closest('.result-tree')) return;
    if (!details.open || !details.querySelector(':scope > summary')) return;
    let button = details.querySelector(':scope > .disclosure-collapse');
    if (!button) {
      button = el('button', 'disclosure-collapse', 'Collapse');
      button.type = 'button';
      button.addEventListener('click', () => {
        const summary = details.querySelector(':scope > summary');
        const top = summary.getBoundingClientRect().top;
        details.open = false;
        summary.focus({ preventScroll: true });
        if (top < messagesEl.getBoundingClientRect().top) {
          summary.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
      });
    }
    if (details.lastElementChild !== button) details.appendChild(button);
  }

  document.addEventListener('toggle', (event) => {
    if (event.target instanceof HTMLDetailsElement) addCollapseControl(event.target);
  }, true);
  // Streaming renderers may replace a disclosure's contents while it stays open.
  new window.MutationObserver(() => {
    for (const details of document.querySelectorAll('details[open]')) addCollapseControl(details);
  }).observe(document.body, { childList: true, subtree: true });

  (document.getElementById('workspace') || messagesEl).addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copy = target.closest('.code-copy');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.closest('.code-block').querySelector('pre code').textContent);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      } catch {
        addError('Could not copy code to the clipboard.');
      }
      return;
    }

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

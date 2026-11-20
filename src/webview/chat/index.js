'use strict';

/**
 * @file Chat Webview Coordinator (`src/webview/chat/index.js`).
 *
 * Bundled by `scripts/build-ui.js` into `media/chat.js`.
 *
 * Enforces a strict, three-phase unidirectional pipeline on every host message
 * and user action:
 *   Phase 1 — History & State Reducer (`store.js`): pure data, zero DOM.
 *   Phase 2 — View Reconciliation (`transcript-renderer.js` & shell views):
 *             pure DOM updates inside `viewport.beginMutation()`, zero scroll writes.
 *   Phase 3 — Viewport & Scroll Commit (`scroll.js`): single scroll calculation,
 *             anchor compensation, deferred fold application, and state persistence.
 *
 * Guidelines for future changes:
 * - Adding a new message/event field? Update `store.js` first and emit a
 *   declarative op or dirty flag.
 * - Changing how steps, thoughts, or cards render/collapse? Edit
 *   `transcript-renderer.js` (and `src/webview/styles/steps-and-tools.css`) and
 *   use `canFold(detailsEl)` — NEVER call `scrollTop` or `scrollIntoView`!
 * - Changing follow-bottom vs parked-reader anchoring? Edit `src/webview/scroll.js`.
 */

const { createChatStore } = require('./store');
const { createFileLinksView } = require('./file-links-view');
const { createHeaderView } = require('./header-view');
const { createUsageView } = require('./usage-view');
const { createComposerView } = require('./composer-view');
const { createPermissionsView } = require('./permissions-view');
const { createTranscriptRenderer } = require('./transcript-renderer');

(function bootstrapChatWebview() {
  const vscode = acquireVsCodeApi();
  const richText = OpenCodeRichText;
  const timeFormat = OpenCodeTime;

  // Shell DOM anchors
  const messagesEl = document.getElementById('messages');
  const workspaceEl = document.getElementById('workspace');
  const emptyEl = document.getElementById('empty');
  const inputEl = document.getElementById('input');
  const composerEl = document.getElementById('composer');
  const composerControls = document.getElementById('composer-controls');
  const questionsEl = document.getElementById('questions');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const activityDetailEl = document.getElementById('activity-detail');
  const activityOperationEl = document.getElementById('activity-operation');
  const activityTargetEl = document.getElementById('activity-target');
  const activityJumpBtn = document.getElementById('activity-jump');
  const usageEl = document.getElementById('usage');
  const usageCostEl = document.getElementById('usage-cost');
  const usageSubscriptionEl = document.getElementById('usage-subscription');
  const usageLinkEl = document.getElementById('usage-link');
  const usageResetEl = document.getElementById('usage-reset');
  const attachmentsEl = document.getElementById('attachments');
  const selectionChipEl = document.getElementById('selection-context');
  const configBarEl = document.getElementById('config-bar');
  const agentLabelEl = document.getElementById('agent-label');
  const slashMenuEl = document.getElementById('slash-menu');
  const subagentsEl = document.getElementById('subagents');
  const subagentsSummaryEl = document.getElementById('subagents-summary');
  const subagentsSummaryTextEl = document.getElementById('subagents-summary-text');
  const subagentsListEl = document.getElementById('subagents-list');
  const planProgressEl = document.getElementById('plan-progress');

  const focusLocal = richText.focusWithoutScroll;
  const persisted = vscode.getState?.() || {};

  // --- Layer 1: Pure State & History Store ---
  const store = createChatStore({
    initialViewport: persisted.viewport || null,
    initialSubmissions: persisted.submissions || [],
  });

  // Debounced webview state persistence
  let viewportTimer = null;
  function saveViewportState() {
    if (store.state.replaying || store.hasRestoredViewport) return;
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      vscode.setState({ ...vscode.getState?.(), viewport: viewport.capture() });
    }, 80);
  }

  function saveSubmissionsState() {
    if (!store.state.sessionId) return;
    vscode.setState({ ...vscode.getState?.(), submissions: store.serializeSubmissions() });
  }

  function saveSessionState() {
    try {
      vscode.setState({
        ...vscode.getState?.(),
        sessionId: store.state.sessionId,
        cwd: store.state.cwd,
      });
    } catch {
      // Ignore state persistence errors.
    }
  }

  // Forward declarations for cross-view wiring
  let transcriptRenderer = null;
  let composerView = null;

  // --- Layer 3: Sole Scroll & Anchor Controller ---
  const viewport = richText.createTranscriptViewport(messagesEl, () => {
    saveViewportState();
    transcriptRenderer?.updateStickyVisibility();
    transcriptRenderer?.applyPendingFolds();
  });

  // --- Layer 2: DOM Views & Reconcilers ---
  const fileLinksView = createFileLinksView({
    store,
    messagesEl,
    workspaceEl,
    richText,
    postMessage: (msg) => vscode.postMessage(msg),
    onCopyError: (text) => commitTransaction(store.ingestHostMessage({ type: 'error', message: text })),
  });

  const artifacts = richText.createArtifacts({
    root: document.getElementById('artifacts'),
    toggle: document.getElementById('artifacts-toggle'),
    renderMarkdown: fileLinksView.renderMarkdown,
    hydrate: (root) => {
      richText.hydrate(root);
      fileLinksView.scheduleFileChecks();
    },
    post: (msg) => vscode.postMessage(msg),
    preferences: persisted.artifacts,
    onAsk: (context, images) => composerView?.selectContext(context, images),
    save: (value) => vscode.setState({ ...vscode.getState?.(), artifacts: value }),
  });

  const headerView = createHeaderView({
    store,
    statusEl,
    statusTextEl,
    activityDetailEl,
    activityOperationEl,
    activityTargetEl,
    subagentsEl,
    subagentsSummaryEl,
    subagentsSummaryTextEl,
    subagentsListEl,
    postMessage: (msg) => vscode.postMessage(msg),
  });

  const usageView = createUsageView({
    store,
    usageEl,
    usageCostEl,
    usageSubscriptionEl,
    usageLinkEl,
    usageResetEl,
    timeFormat,
    postMessage: (msg) => vscode.postMessage(msg),
  });

  const permissionsView = createPermissionsView({
    store,
    messagesEl,
    composerEl,
    questionsEl,
    richText,
    focusLocal,
    getToolCard: (id) => transcriptRenderer?.getToolCard(id) || null,
    postMessage: (msg) => vscode.postMessage(msg),
    onAttentionResolved: (key) => {
      store.resolveAttention(key);
      headerView.sync();
    },
    onQuestionsChanged: () => composerView?.updateComposer(),
  });

  transcriptRenderer = createTranscriptRenderer({
    store,
    messagesEl,
    emptyEl,
    planProgressEl,
    richText,
    timeFormat,
    artifacts,
    renderMarkdown: fileLinksView.renderMarkdown,
    scheduleFileChecks: fileLinksView.scheduleFileChecks,
    permissionsView,
    focusLocal,
    canFold: (detailsEl) => !viewport.foldingMoves(detailsEl),
    isFollowing: () => viewport.following,
    onAsyncLayout: () => viewport.schedule(),
    onResendSubmission: (id) => {
      const { tx, outbound } = store.prepareResend(id);
      commitTransaction(tx);
      if (outbound) vscode.postMessage(outbound);
    },
    postMessage: (msg) => vscode.postMessage(msg),
  });

  composerView = createComposerView({
    store,
    composerEl,
    composerControls,
    questionsEl,
    inputEl,
    sendBtn,
    stopBtn,
    attachmentsEl,
    selectionChipEl,
    slashMenuEl,
    configBarEl,
    agentLabelEl,
    focusLocal,
    modelPickerFactory: () =>
      typeof OpenCodeModelPicker !== 'undefined' ? OpenCodeModelPicker : null,
    postMessage: (msg) => vscode.postMessage(msg),
    onSend: (rawText) => {
      const makeId = () => `msg_${crypto.randomUUID().replaceAll('-', '')}`;
      const { tx, outbound, clearedInput } = store.prepareSend(rawText, makeId);
      if (clearedInput) composerView.clearInput();
      commitTransaction(tx);
      if (outbound) {
        vscode.postMessage(outbound);
        composerView.focusComposerInput();
      }
    },
    onStop: () => {
      const { tx, outbound } = store.prepareStop();
      commitTransaction(tx);
      if (outbound) vscode.postMessage(outbound);
    },
    onInfo: (text) => commitTransaction(store.ingestHostMessage({ type: 'info', text })),
  });

  // --- Single Unidirectional Commit Pipeline (Phase 2 DOM -> Phase 3 Scroll) ---
  function commitTransaction(tx) {
    const hasDomWork =
      tx.ops.length > 0 ||
      tx.dirty.header ||
      tx.dirty.composer ||
      tx.dirty.usage ||
      tx.dirty.config ||
      tx.dirty.attachments ||
      tx.dirty.selection ||
      tx.dirty.slash ||
      tx.dirty.subagents ||
      tx.dirty.questions ||
      tx.dirty.archived;

    if (hasDomWork) viewport.beginMutation();
    try {
      if (tx.dirty.title && store.state.title) {
        document.title = store.state.title;
      }
      if (tx.dirty.archived && store.state.archived) {
        permissionsView.clearQuestions();
      }
      if (tx.ops.length > 0) {
        transcriptRenderer.reconcile(tx.ops, { initial: tx.initialTranscript });
      }
      if (tx.dirty.attachments) composerView.renderAttachments();
      if (tx.dirty.selection) composerView.renderSelection();
      if (tx.dirty.config) composerView.renderConfigOptions();
      if (tx.dirty.slash) {
        if (!store.state.connected || store.state.archived) {
          composerView.closeSlashMenu();
        } else if (store.state.slashOpen || composerView.isInputFocused) {
          composerView.refreshSlashMenu();
        }
      }
      if (tx.dirty.subagents) headerView.renderSubagents();
      if (tx.dirty.usage) usageView.render();
      if (tx.dirty.header || tx.ops.length > 0) headerView.sync();
      if (tx.dirty.composer || tx.dirty.archived) composerView.updateComposer();
      if (tx.dirty.fileChecks) fileLinksView.applyFileChecks();
    } finally {
      if (hasDomWork) {
        const intent = resolveViewportCommitIntent(tx.scrollIntent);
        viewport.endMutation(intent);
      } else if (tx.scrollIntent) {
        applyStandaloneScrollIntent(tx.scrollIntent);
      }
    }

    if (tx.dirty.saveSession) saveSessionState();
    if (tx.dirty.saveSubmissions) saveSubmissionsState();
    if (tx.dirty.saveViewport) saveViewportState();
  }

  function resolveViewportCommitIntent(scrollIntent) {
    if (!scrollIntent) return null;
    if (scrollIntent.type === 'bottom') return { type: 'bottom' };
    if (scrollIntent.type === 'restore' && scrollIntent.viewport) {
      return { type: 'restore', viewport: scrollIntent.viewport };
    }
    if (scrollIntent.type === 'historyEnd') {
      if (scrollIntent.viewport) {
        const saved = scrollIntent.viewport;
        requestAnimationFrame(() => viewport.restore(saved));
        return { type: 'restore', viewport: saved };
      }
      return viewport.following ? { type: 'bottom' } : null;
    }
    if (scrollIntent.type === 'focusComposer') {
      const shouldBottom = (!questionsEl || questionsEl.hidden) && !store.state.archived && viewport.following;
      queueMicrotask(() => composerView.focusComposerInput());
      return shouldBottom ? { type: 'bottom' } : null;
    }
    return null;
  }

  function applyStandaloneScrollIntent(scrollIntent) {
    if (scrollIntent.type === 'focusComposer') {
      if (store.state.archived) return;
      if (questionsEl && !questionsEl.hidden) {
        composerView.focusComposerInput();
        return;
      }
      if (viewport.following) viewport.bottom();
      composerView.focusComposerInput();
    } else if (scrollIntent.type === 'bottom') {
      viewport.bottom();
    } else if (scrollIntent.type === 'restore' && scrollIntent.viewport) {
      viewport.restore(scrollIntent.viewport);
    }
  }

  // Header "Jump to current message" button
  activityJumpBtn?.addEventListener('click', () => {
    const request = store.currentAttention();
    const target = request
      ? permissionsView.getAttentionTarget(request.key)
      : transcriptRenderer.resolveActionTarget(store.state.currentAction?.targetRef);
    if (!target || target.hidden) {
      viewport.bottom();
      return;
    }
    for (let parent = target.parentElement; parent && parent !== messagesEl; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    viewport.pause();
    const focusTarget = request
      ? target.querySelector('input, textarea, select, button:not(.disclosure-collapse)')
      : null;
    const container = questionsEl?.contains(target) ? questionsEl : messagesEl;
    richText.scrollToElement(container, focusTarget || target, { behavior: 'smooth' });
    focusLocal(focusTarget);
  });

  // Window message & focus wiring
  window.addEventListener('message', (event) => {
    const tx = store.ingestHostMessage(event.data);
    commitTransaction(tx);
  });

  // Editor tab cycling from a focused webview is racy: the VS Code webview
  // preload re-posts every keydown that reaches `window` (bubble phase) to the
  // workbench keybinding service, so Ctrl+PageDown can dispatch nextEditor
  // twice (microsoft/vscode#241801) or be dropped for a lazily restored tab
  // (microsoft/vscode#347573). Claim the default editor-cycling combos in the
  // capture phase, before the preload can forward them, and ask the host to
  // run the command exactly once per press (see `navigateEditor` in
  // session-panel.js). Combos with Alt/Shift stay untouched: they belong to
  // other workbench bindings (move editor, editor-in-group chords).
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const direction = event.key === 'PageDown' ? 'next' : event.key === 'PageUp' ? 'previous' : null;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: 'navigateEditor', direction });
  }, true);

  window.addEventListener('focus', () => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    try {
      focusLocal(inputEl, composerControls);
    } catch {
      // Ignore focus errors in older webviews.
    }
  });

  // Initial paint & handshake
  composerView.resizeInput();
  composerView.updateComposer();
  usageView.render();
  vscode.postMessage({ type: 'ready' });
})();

'use strict';

/**
 * @file Layer 2 View: Fixed activity header, 1-second elapsed timer, shared
 * background-pulse timeline alignment, and the collapsible Sub-agents strip.
 *
 * Strictly DOM-only — never mutates scroll state directly (navigation clicks
 * delegate to callbacks provided by the coordinator).
 */

const { el } = require('./dom');
const { formatElapsed, formatCompact, formatTokens, formatExactTokens } = require('./format');
const { STATUS_LABELS } = require('./store');

function syncBackgroundPulse() {
  // CSS animations start when their elements appear. A shared document timeline
  // keeps late-arriving labels in phase with the header dot.
  for (const node of document.querySelectorAll('#status.background .dot, .background-state[data-running="true"]')) {
    if (typeof node.getAnimations !== 'function') continue;
    for (const animation of node.getAnimations()) {
      if (animation.animationName === 'background-pulse' && animation.startTime !== 0) {
        animation.startTime = 0;
      }
    }
  }
}

function createHeaderView({
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
  postMessage,
}) {
  let liveClock = null;

  function renderElapsed() {
    const { state } = store;
    const request = state.statusKind === 'cancelling' ? null : store.currentAttention();
    const active = request || (state.busy ? state.currentAction : null);
    const runs = store.activeBackgroundRuns();
    const background = state.statusKind === 'ready' && runs.length > 0;
    const kind = request ? 'attention' : background ? 'background' : state.statusKind;
    const summary =
      request?.summary ||
      (state.busy && !state.externalBusy && kind !== 'cancelling'
        ? state.activityThought ||
          state.activityPlan ||
          state.activityPurpose ||
          active?.summary ||
          state.statusText
        : background
          ? 'Working in background…'
          : state.statusText);

    statusEl.className = 'status ' + kind;
    statusEl.title = request
      ? 'Needs your input'
      : background
        ? 'Working in background…'
        : STATUS_LABELS[kind] || kind;
    if (statusTextEl.textContent !== summary) statusTextEl.textContent = summary;
    statusTextEl.title = summary;

    const starts = runs.map((run) => run.time?.started).filter(Number.isFinite);
    const startedAt =
      kind === 'background'
        ? starts.length
          ? Math.min(...starts)
          : null
        : request?.startedAt ?? state.liveStartedAt;
    const operation =
      kind === 'background'
        ? `running ${runs.length} ${runs.length === 1 ? 'command' : 'commands'}`
        : active?.kind || (state.busy && !state.externalBusy ? 'working' : '');

    activityDetailEl.hidden = !operation;
    activityOperationEl.textContent = operation
      ? `${operation}${
          startedAt !== null && startedAt !== undefined
            ? ' for ' + formatElapsed(Date.now() - startedAt)
            : ''
        }`
      : '';
    activityTargetEl.textContent = active?.text || '';
    activityTargetEl.title = active?.text || '';
    activityTargetEl.hidden = !active?.text;
    syncBackgroundPulse();
  }

  function startClock() {
    if (liveClock) return;
    liveClock = setInterval(renderElapsed, 1000);
    liveClock.unref?.();
  }

  function stopClock() {
    if (!liveClock) return;
    clearInterval(liveClock);
    liveClock = null;
  }

  function sync() {
    const { state } = store;
    const shouldTick =
      (state.busy && !state.externalBusy) ||
      state.attentionRequests.size > 0 ||
      (state.statusKind === 'ready' && store.activeBackgroundRuns().length > 0);
    if (shouldTick) startClock();
    else stopClock();
    renderElapsed();
  }

  function renderSubagents() {
    if (!subagentsEl) return;
    const items = store.state.subagents;
    if (!items || items.length === 0) {
      subagentsEl.hidden = true;
      subagentsListEl.replaceChildren();
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
      summary += ' · ' + (allExact ? '' : '~') + formatCompact(totalTokens) + ' tok';
    }
    subagentsSummaryTextEl.textContent = summary;

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
        meta.appendChild(el('span', 'subagent-tokens', item.exact ? '0 tok' : '~0 tok'));
      }
      li.appendChild(head);
      li.appendChild(meta);
      if (!item.running && item.result) li.appendChild(el('div', 'subagent-result', item.result));
      li.addEventListener('click', () => {
        if (item.id) postMessage({ type: 'openSession', sessionId: item.id });
      });
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (item.id) postMessage({ type: 'openSession', sessionId: item.id });
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

  subagentsSummaryEl?.addEventListener('click', () => {
    setSubagentsExpanded(subagentsSummaryEl.getAttribute('aria-expanded') !== 'true');
  });

  return {
    sync,
    renderElapsed,
    renderSubagents,
    syncBackgroundPulse,
  };
}

module.exports = { createHeaderView, syncBackgroundPulse };

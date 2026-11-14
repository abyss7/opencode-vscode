'use strict';

/**
 * @file Layer 2 View: Context usage meter, compaction threshold mark, cost/budget
 * ledger, subscription plan windows, and fixed hover/focus tooltips.
 *
 * Pure formatting and math come from `./format.js`; this module only projects
 * `store.state` into the footer DOM.
 */

const { el } = require('./dom');
const {
  formatCompact,
  formatDuration,
  formatCost,
  formatMoney,
  compactionThreshold,
  cacheTooltip,
  costTooltip,
  nextReset,
  planUsageParts,
} = require('./format');

function positionTooltipAbove(tooltip, anchor) {
  if (!anchor || tooltip.hidden) return;
  const rect = anchor.getBoundingClientRect();
  const width = tooltip.getBoundingClientRect().width;
  const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1000;
  tooltip.style.left = `${Math.max(8, Math.min(vw - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
  tooltip.style.top = `${Math.max(8, rect.top - (tooltip.offsetHeight || 0) - 6)}px`;
}

function createUsageView({
  store,
  usageEl,
  usageCostEl,
  usageSubscriptionEl,
  usageLinkEl,
  usageResetEl,
  timeFormat,
  postMessage,
}) {
  const usageTooltipEl = el('span', 'usage-tooltip');
  const planTooltipEl = el('span', 'usage-tooltip plan');

  usageTooltipEl.id = 'usage-tooltip';
  usageTooltipEl.setAttribute('role', 'tooltip');
  usageTooltipEl.hidden = true;
  document.body.appendChild(usageTooltipEl);

  planTooltipEl.id = 'usage-plan-tooltip';
  planTooltipEl.setAttribute('role', 'tooltip');
  planTooltipEl.hidden = true;
  document.body.appendChild(planTooltipEl);

  const positionUsage = () => positionTooltipAbove(usageTooltipEl, usageEl);
  const positionPlan = () => positionTooltipAbove(planTooltipEl, usageSubscriptionEl);
  const hideUsage = () => { usageTooltipEl.hidden = true; };
  const hidePlan = () => { planTooltipEl.hidden = true; };

  if (usageEl) {
    usageEl.setAttribute('aria-describedby', usageTooltipEl.id);
    const show = () => { usageTooltipEl.hidden = false; positionUsage(); };
    usageEl.addEventListener('pointerenter', show);
    usageEl.addEventListener('pointerleave', () => {
      if (document.activeElement !== usageEl) hideUsage();
    });
    usageEl.addEventListener('focus', show);
    usageEl.addEventListener('blur', () => {
      if (!usageEl.matches?.(':hover')) hideUsage();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideUsage();
        hidePlan();
      }
    });
    document.addEventListener('scroll', () => {
      hideUsage();
      hidePlan();
    }, true);
    window.addEventListener('resize', () => {
      positionUsage();
      positionPlan();
    });
  }

  if (usageSubscriptionEl) {
    usageSubscriptionEl.setAttribute('aria-describedby', planTooltipEl.id);
    const showPlan = () => { planTooltipEl.hidden = false; positionPlan(); };
    usageSubscriptionEl.addEventListener('pointerenter', showPlan);
    usageSubscriptionEl.addEventListener('pointerleave', () => {
      if (document.activeElement !== usageSubscriptionEl) hidePlan();
    });
  }

  usageLinkEl?.addEventListener('click', (event) => {
    event.preventDefault();
    postMessage({
      type: 'openExternal',
      url: store.state.modelLimit?.billing?.url || 'https://chatgpt.com/settings/usage',
    });
  });

  function render() {
    if (!usageEl) return;
    const { state } = store;
    usageResetEl.title = 'Budget reset time';
    const usage = state.usage;
    const cache = state.cacheStats;
    const limit = state.modelLimit || {};
    const context = Number(limit.context) || Number(usage && usage.size) || 0;
    const windowSize = Number(limit.input) || context;
    const prompt = cache && Number(cache.prompt) > 0 ? Number(cache.prompt) : 0;
    const rawUsed = prompt > 0 ? prompt : usage && typeof usage.used === 'number' ? usage.used : null;
    const used = Number.isFinite(rawUsed) && rawUsed >= 0 ? rawUsed : null;
    const capacity = Number.isFinite(windowSize) && windowSize > 0 ? windowSize : 0;
    const tokens = (value) => `${value.toLocaleString('en-US')} tokens`;

    const parts = [
      `Context used: ${used === null ? 'unknown' : tokens(used)}`,
      `Context capacity: ${capacity > 0 ? tokens(capacity) : 'unknown'}`,
    ];
    const cached = cacheTooltip(cache);
    if (cached) parts.push(cached);
    const threshold = compactionThreshold(context, limit.input, state.compaction);
    const hasThreshold = capacity > 0 && Number.isFinite(threshold) && threshold > 0;
    if (hasThreshold) {
      parts.push(`Compaction threshold: ${tokens(threshold)}`);
    } else if (state.compaction && state.compaction.auto === false) {
      parts.push('Automatic compaction: disabled');
    }

    const description = parts.join('\n');
    const compact = [
      `context: ${used === null ? '—' : formatCompact(used)}` +
        (capacity > 0 ? ` / ${formatCompact(capacity)}` : '') +
        cacheTooltip(cache, true),
    ];
    if (hasThreshold) compact.push(`compaction at ${formatCompact(threshold)}`);
    usageTooltipEl.textContent = compact.join(' · ');
    positionUsage();

    usageEl.setAttribute('aria-label', description);
    const known = capacity > 0 && used !== null;
    usageEl.setAttribute('role', known ? 'meter' : 'img');
    for (const [name, value] of Object.entries({
      'aria-valuemin': known ? 0 : null,
      'aria-valuemax': known ? capacity : null,
      'aria-valuenow': known ? Math.min(used, capacity) : null,
    })) {
      if (value === null) usageEl.removeAttribute(name);
      else usageEl.setAttribute(name, String(value));
    }

    const percent = (value) =>
      capacity > 0 && Number.isFinite(value)
        ? Math.max(0, Math.min(100, (value / capacity) * 100))
        : 0;
    const read = cache ? Number(cache.read) : 0;
    const fraction = known ? used / capacity : 0;
    usageEl.dataset.contextLevel =
      fraction >= 2 / 3 ? 'red' : fraction >= 1 / 3 ? 'yellow' : 'green';
    usageEl.style.setProperty('--context-used', `${percent(used)}%`);
    usageEl.style.setProperty('--context-cached', `${percent(Math.min(used || 0, read))}%`);
    usageEl.style.setProperty('--context-threshold', `${percent(threshold)}%`);
    const thresholdEl = usageEl.querySelector('.usage-threshold');
    if (thresholdEl) thresholdEl.hidden = !hasThreshold;

    // Billing follows the selected model, not a mixed session sum.
    const billing = limit.billing || { kind: limit.subscription ? 'subscription' : 'metered' };
    const subscription = billing.kind === 'subscription';
    const metered = billing.kind === 'metered';
    if (usageSubscriptionEl) usageSubscriptionEl.hidden = !subscription;
    if (subscription && billing.label && usageSubscriptionEl) {
      const plan = planUsageParts(state.balance, (ts) => timeFormat.formatTimestamp(ts));
      usageSubscriptionEl.firstChild.textContent = plan.line || `${billing.label} · `;
      planTooltipEl.textContent = plan.tooltip;
      positionPlan();
      usageLinkEl.href = billing.url;
      usageLinkEl.hidden = Boolean(plan.line);
      usageLinkEl.textContent = plan.line ? '' : 'usage ↗';
    }

    const scoped = !!limit.model;
    const split = state.costSplit;
    const matches =
      !scoped ||
      (split?.model?.providerID === limit.model.providerID && split?.model?.id === limit.model.id);
    const cost = scoped
      ? matches && split
        ? { amount: split.total, currency: 'USD' }
        : null
      : usage && usage.cost;
    const currency = (cost && cost.currency) || 'USD';
    const parentCost = cost && typeof cost.amount === 'number' ? cost.amount : 0;
    const subagentCost = scoped ? 0 : Number(state.subagentCost) || 0;
    let costText = '';
    if (cost && typeof cost.amount === 'number' && (!subscription || parentCost + subagentCost > 0)) {
      costText = `cost: ${formatCost(parentCost + subagentCost, currency)}`;
      if (subagentCost > 0) {
        costText += ` (sub-agents ${formatCost(subagentCost, currency)})`;
      }
    } else if (subagentCost > 0) {
      costText = `cost: ${formatCost(subagentCost, currency)} (sub-agents)`;
    }
    if (!metered) costText = '';

    const budget = metered ? state.budget : null;
    if (budget && typeof budget.remaining === 'number') {
      const suffix = budget.modelMatched && budget.label ? ` for ${budget.label}` : '';
      costText += (costText ? ' · ' : '') + `$${budget.remaining.toFixed(2)} left${suffix}`;
    }

    const balance = metered ? state.balance : null;
    if (balance && typeof balance.amount === 'number') {
      costText +=
        (costText ? ' · ' : '') + `balance: ${formatMoney(balance.amount, balance.currency)}`;
    }
    usageCostEl.textContent = costText;
    usageCostEl.hidden = !costText;
    usageCostEl.title = metered && matches ? costTooltip(split, subagentCost) : '';

    const resetAt = metered ? nextReset(state.limits, budget) : 0;
    if (resetAt) {
      usageResetEl.textContent = `reset in ${formatDuration(resetAt - Date.now())}`;
      usageResetEl.hidden = false;
    } else {
      usageResetEl.textContent = '';
      usageResetEl.hidden = true;
    }
  }

  return { render };
}

module.exports = { createUsageView };

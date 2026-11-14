'use strict';

/**
 * @file Pure formatting and billing/context calculation utilities.
 *
 * Layer 0: strictly stateless and DOM-free so every calculation can be unit
 * tested directly in Node without a browser or DOM harness.
 */

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

function formatAgo(at, compact = false, now = Date.now()) {
  const time = Number(at) || 0;
  if (time <= 0) return '';
  const elapsed = now - time;
  if (!Number.isFinite(elapsed) || elapsed < 60000) return 'just now';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) return `${minutes} ${compact ? 'min' : minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 36) return `${hours} ${compact ? 'h' : hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${compact ? 'd' : days === 1 ? 'day' : 'days'} ago`;
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

/**
 * Mirrors the server: the provider-declared input window wins over the context
 * window; a configured buffer shorter than it is subtracted, otherwise the
 * default is max(15% of the window, 16k for windows >= 32k).
 */
function compactionThreshold(context, input, compaction) {
  const total = Number(input) || Number(context) || 0;
  if (total <= 0) return 0;
  const cfg = compaction || {};
  if (cfg.auto === false) return 0;
  const buffer = typeof cfg.buffer === 'number' ? cfg.buffer : NaN;
  if (Number.isFinite(buffer) && buffer < total) return total - buffer;
  return total - Math.max(Math.floor(total * 0.15), total >= 32000 ? 16000 : 0);
}

function cacheTooltip(cache, compact = false, now = Date.now()) {
  const prompt = cache && Number(cache.prompt) > 0 ? Number(cache.prompt) : 0;
  if (!Number.isFinite(prompt) || prompt <= 0) return '';
  const read = Number.isFinite(Number(cache.read)) ? Math.max(0, Number(cache.read)) : 0;
  const percent = Math.floor((read / prompt) * 100000) / 1000;
  if (compact) {
    const pieces = [`${percent}% cached`];
    const ago = formatAgo(cache.at, true, now);
    if (ago) pieces.push(ago);
    return ` (${pieces.join(' ')})`;
  }
  const pieces = [`${percent}% of current context`];
  const ago = formatAgo(cache.at, false, now);
  if (ago) pieces.push(`measured ${ago}`);
  return `Cached context: ${read.toLocaleString('en-US')} tokens (${pieces.join('; ')})`;
}

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

function nextReset(limits, budget, now = Date.now()) {
  if (budget && typeof budget.resetsAt === 'number' && budget.resetsAt > now) {
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

function planUsageParts(balance, formatTimestamp, now = Date.now()) {
  const windows = Array.isArray(balance && balance.windows)
    ? balance.windows.filter((item) => item && Number.isFinite(Number(item.percentage)))
    : [];
  if (windows.length === 0) return { line: '', tooltip: '' };
  const resetLeft = (item) =>
    Number(item.resetsAt) > now ? formatDuration(item.resetsAt - now) : '';
  const line = windows
    .map((item) => [resetLeft(item), `↻ ${Math.round(Number(item.percentage))}%`].filter(Boolean).join(' '))
    .join(' · ');
  const rows = windows.map((item) => ({
    label: item.kind === 'weekly' ? 'weekly' : '5-hour',
    used: Number(item.limit) > 0 ? formatCompact(item.used) : '',
    limit: Number(item.limit) > 0 ? `${formatCompact(item.limit)} ${item.unit}` : '',
    percent: `${Math.round(Number(item.percentage))}% used`,
    reset: Number(item.resetsAt) > now ? `resets ${formatTimestamp(item.resetsAt)}` : '',
  }));
  const hasQuota = rows.some((row) => row.used !== '');
  const usedWidth = hasQuota ? Math.max(...rows.map((row) => row.used.length)) : 0;
  const quotaWidth = hasQuota
    ? Math.max(...rows.map((row) => row.used.length + 3 + row.limit.length))
    : 0;
  const width = (key) => Math.max(...rows.map((row) => row[key].length));
  const tooltip = rows
    .map((row) => {
      const quota =
        row.used === ''
          ? ' '.repeat(quotaWidth)
          : `${row.used.padStart(usedWidth)} / ${row.limit}`.padEnd(quotaWidth);
      return [
        row.label.padEnd(width('label')),
        hasQuota ? quota : '',
        row.percent.padEnd(width('percent')),
        row.reset,
      ]
        .filter((cell) => cell !== '')
        .join(' · ')
        .trimEnd();
    })
    .join('\n');
  return { line, tooltip };
}

module.exports = {
  escapeHtml,
  estimateTokens,
  oneLine,
  prefixLine,
  formatCompact,
  formatTokens,
  formatExactTokens,
  formatTurnTokens,
  formatAgo,
  formatDuration,
  formatElapsed,
  alignMoney,
  formatCost,
  formatMoney,
  compactionThreshold,
  cacheTooltip,
  costTooltip,
  nextReset,
  planUsageParts,
};

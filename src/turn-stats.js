'use strict';

const PART_TEXT_LIMIT = 20000;

/**
 * JSON of a tool argument, safe against cycles and unserializable values.
 */
function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : '';
  } catch (error) {
    return '';
  }
}

/**
 * Rough token estimate for a restored part. Uses the same four-characters
 * per-token heuristic as the webview, so restored and live numbers stay
 * comparable.
 */
function estimatePartTokens(part) {
  if (!part || typeof part !== 'object') return 0;
  let text = typeof part.text === 'string' ? part.text : '';
  const state = part.state || {};
  if (state.input !== undefined) text += safeJson(state.input);
  const content = state.content;
  if (typeof content === 'string') {
    text += content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string') {
        text += item.text;
      } else if (item.content && typeof item.content === 'string') {
        text += item.content;
      } else if (item.content && typeof item.content.text === 'string') {
        text += item.content.text;
      }
    }
  }
  if (state.output !== undefined) {
    text += safeJson(state.output);
  }
  if (!text.trim()) return 0;
  return Math.ceil(Math.min(text.length, PART_TEXT_LIMIT) / 4);
}

function addKind(kinds, kind) {
  if (kind && !kinds.includes(kind) && kinds.length < 8) kinds.push(kind);
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Exact billed usage of one assistant message, or null when the server stored
 * no counters for it. Same arithmetic the ACP result uses: the prompt is
 * `input + cache.read + cache.write`, and `output`/`reasoning` are counted once.
 */
function messageUsage(message) {
  const tokens = message && message.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const usage = {
    input: count(tokens.input),
    output: count(tokens.output),
    reasoning: count(tokens.reasoning),
    read: count(cache.read),
    write: count(cache.write),
  };
  usage.billed = usage.input + usage.output + usage.reasoning + usage.read + usage.write;
  return usage.billed > 0 ? usage : null;
}

function emptyTurn() {
  return {
    steps: 0,
    tokens: 0,
    kinds: [],
    served: 0,
    cacheRead: 0,
    cacheWrite: 0,
    // Exact counters replace the estimate only when every assistant message of
    // the turn carries them; a partial restore would silently undercount.
    missingUsage: false,
    messages: 0,
  };
}

function foldTurn(turn) {
  const exact = turn.messages > 0 && !turn.missingUsage && turn.served > 0;
  const stat = {
    steps: turn.steps,
    tokens: exact ? turn.served : turn.tokens,
    kinds: turn.kinds,
    exact,
  };
  if (exact) {
    stat.cacheRead = turn.cacheRead;
    stat.cacheWrite = turn.cacheWrite;
  }
  return stat;
}

/**
 * Per-turn step and token counters rebuilt from the server's message history.
 * The endpoint reports one `user` message per turn, then the assistant messages
 * that answered it. When every assistant message of a turn carries the stored
 * `tokens` counters, those exact values replace the four-characters-per-token
 * estimate; otherwise the estimate stays and is marked as such.
 */
function buildTurnStats(messages) {
  const turns = [];
  let current = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.type === 'user') {
      current = emptyTurn();
      turns.push(current);
      continue;
    }
    if (message.type !== 'assistant') continue;
    if (!current) {
      current = emptyTurn();
      turns.push(current);
    }
    current.messages += 1;
    const usage = messageUsage(message);
    if (usage) {
      current.served += usage.billed;
      current.cacheRead += usage.read;
      current.cacheWrite += usage.write;
    } else {
      current.missingUsage = true;
    }
    let hasText = false;
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool') {
        current.steps += 1;
        current.tokens += estimatePartTokens(part);
        addKind(current.kinds, part.name || 'tool');
      } else if (part.type === 'reasoning') {
        current.steps += 1;
        current.tokens += estimatePartTokens(part);
        addKind(current.kinds, 'thought');
      } else if (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.trim()
      ) {
        hasText = true;
        current.tokens += estimatePartTokens(part);
      }
    }
    if (hasText) {
      current.steps += 1;
      addKind(current.kinds, 'text');
    }
  }
  return turns.filter((turn) => turn.steps > 0).map(foldTurn);
}

module.exports = { buildTurnStats, estimatePartTokens };

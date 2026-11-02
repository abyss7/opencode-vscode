'use strict';

const assert = require('node:assert');
const { buildTurnStats, estimatePartTokens } = require('../src/turn-stats');

// One turn: reasoning, a tool call with input and output, and a final answer.
const messages = [
  { type: 'model-switched' },
  { type: 'user', content: 'do it' },
  {
    type: 'assistant',
    content: [
      { type: 'reasoning', text: 'x'.repeat(400) },
      {
        type: 'tool',
        name: 'shell',
        state: {
          status: 'completed',
          input: { command: 'ls -la' },
          content: [{ type: 'text', text: 'y'.repeat(800) }],
        },
      },
      { type: 'text', text: 'done' },
    ],
  },
  { type: 'user', content: 'again' },
  { type: 'assistant', content: [{ type: 'text', text: 'ok' }] },
];

const turns = buildTurnStats(messages);
assert.strictEqual(turns.length, 2, 'one entry per user turn');

// 1 reasoning + 1 tool + 1 text message = 3 steps.
assert.strictEqual(turns[0].steps, 3);
assert.deepStrictEqual(turns[0].kinds, ['thought', 'shell', 'text']);
assert.ok(turns[0].tokens > 300, 'tokens grow with content length');

assert.strictEqual(turns[1].steps, 1);
assert.deepStrictEqual(turns[1].kinds, ['text']);

// Turns without steps are dropped: the webview shows nothing for them.
assert.deepStrictEqual(buildTurnStats([{ type: 'user' }]), []);
assert.deepStrictEqual(buildTurnStats([]), []);

// A turn that starts without a user message (partial page) is still counted.
const partial = buildTurnStats([
  { type: 'assistant', content: [{ type: 'tool', name: 'read', state: {} }] },
]);
assert.strictEqual(partial.length, 1);
assert.strictEqual(partial[0].steps, 1);

// Non-assistant/user messages do not affect the counters.
assert.deepStrictEqual(
  buildTurnStats([
    { type: 'user' },
    { type: 'assistant', content: [{ type: 'step-start' }] },
  ]),
  []
);

// Token estimates follow the four-characters-per-token heuristic and are cut
// at the same 20000-character limit the webview applies to tool output.
assert.strictEqual(estimatePartTokens({ type: 'text', text: 'abcd' }), 1);
assert.strictEqual(estimatePartTokens({ type: 'text', text: 'a'.repeat(8000) }), 2000);
assert.strictEqual(estimatePartTokens({ type: 'text', text: 'a'.repeat(100000) }), 5000);
assert.strictEqual(estimatePartTokens({ type: 'text', text: '   ' }), 0);
assert.strictEqual(estimatePartTokens(null), 0);

// `state.output` is counted even when `state.content` is an array; that branch
// used to be unreachable and dropped tool output tokens.
assert.ok(
  estimatePartTokens({ state: { content: [], output: 'a'.repeat(80) } }) > 0,
  'state.output is counted alongside array content'
);

// Stored counters make the turn exact: the billed sum replaces the estimate and
// the cache split travels with it. `output` and `reasoning` are counted once.
const exactTurn = buildTurnStats([
  { type: 'user' },
  {
    type: 'assistant',
    tokens: {
      input: 1000,
      output: 200,
      reasoning: 50,
      cache: { read: 8000, write: 250 },
    },
    content: [{ type: 'text', text: 'ok' }],
  },
]);
assert.strictEqual(exactTurn.length, 1);
assert.strictEqual(exactTurn[0].exact, true);
assert.strictEqual(exactTurn[0].tokens, 9500);
assert.strictEqual(exactTurn[0].cacheRead, 8000);
assert.strictEqual(exactTurn[0].cacheWrite, 250);

// Multi-step turns sum every assistant message, which is how the ACP result
// accumulates `usage.turn`.
const multiStep = buildTurnStats([
  { type: 'user' },
  {
    type: 'assistant',
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 900, write: 0 } },
    content: [{ type: 'tool', name: 'shell', state: {} }],
  },
  {
    type: 'assistant',
    tokens: { input: 120, output: 20, reasoning: 5, cache: { read: 980, write: 0 } },
    content: [{ type: 'text', text: 'done' }],
  },
]);
assert.strictEqual(multiStep[0].exact, true);
assert.strictEqual(multiStep[0].steps, 2);
assert.strictEqual(multiStep[0].tokens, 100 + 10 + 900 + 120 + 20 + 5 + 980);
assert.strictEqual(multiStep[0].cacheRead, 1880);

// One assistant message without counters demotes the whole turn to the
// estimate: a partial sum would understate the bill.
const partialUsage = buildTurnStats([
  { type: 'user' },
  {
    type: 'assistant',
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 900, write: 0 } },
    content: [{ type: 'tool', name: 'shell', state: {} }],
  },
  { type: 'assistant', content: [{ type: 'text', text: 'ok' }] },
]);
assert.strictEqual(partialUsage[0].exact, false);
assert.strictEqual(partialUsage[0].cacheRead, undefined);
assert.ok(partialUsage[0].tokens > 0, 'the estimate stays in place');

// All-zero counters (an aborted step) do not count as exact usage.
const emptyUsage = buildTurnStats([
  { type: 'user' },
  {
    type: 'assistant',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: 'text', text: 'ok' }],
  },
]);
assert.strictEqual(emptyUsage[0].exact, false);

console.log('TURN STATS OK');

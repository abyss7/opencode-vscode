'use strict';

/**
 * @file Architectural contract tests for the 3-layer Chat Webview design.
 *
 * Verifies in pure Node (with NO `document`, `window`, or DOM mocks) that:
 * 1. Layer 1 (`src/webview/chat/store.js`) updates history, turns, submissions,
 *    usage, slash items, and live activity purely in memory and emits structured
 *    render transactions (`ops`, `dirty`, `scrollIntent`).
 * 2. Layer 0 (`src/webview/chat/format.js` & `tool-metadata.js`) computes step
 *    summaries, file deduplication, token headers, and captions deterministically.
 * 3. Layer 2 (`src/webview/chat/*-view.js` & `transcript-renderer.js`) contains
 *    no direct `scrollTop` assignments or ad-hoc `scrollToBottom` helpers.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(typeof global.document, 'undefined', 'Layer 1 must run with no DOM globals');

const { createChatStore } = require('../src/webview/chat/store');
const {
  compactionThreshold,
  formatTurnTokens,
  planUsageParts,
} = require('../src/webview/chat/format');
const {
  summarizeTools,
  scanThoughtCaption,
  permissionPatchOperations,
} = require('../src/webview/chat/tool-metadata');

// 1. Pure store lifecycle: session -> prompt send -> native snapshot -> turnEnd
{
  const store = createChatStore({
    initialViewport: { bottom: false, anchor: 'm1:0', offset: 12 },
    initialSubmissions: [
      { id: 'msg_cached', state: 'sending', item: { id: 'msg_cached', payload: { text: 'Cached' } } },
    ],
  });

  const sessionTx = store.ingestHostMessage({
    type: 'session',
    sessionId: 'ses_arch',
    cwd: '/workspace',
  });
  assert.equal(store.state.sessionId, 'ses_arch');
  assert.equal(store.state.submissions.get('msg_cached').state, 'unknown',
    'in-flight sending submission from a reloaded webview becomes unconfirmed');
  assert.equal(sessionTx.dirty.saveSession, true);
  assert.equal(sessionTx.dirty.saveSubmissions, true);

  store.ingestHostMessage({ type: 'capabilities', transport: 'server', images: true });
  store.ingestHostMessage({ type: 'status', state: 'ready' });
  assert.equal(store.state.connected, true);

  // Deliberate user send produces a 'bottom' scrollIntent, never mutating DOM directly.
  const { tx: sendTx, outbound } = store.prepareSend('Refactor webview', () => 'msg_1');
  assert.equal(outbound.type, 'prompt');
  assert.equal(outbound.id, 'msg_1');
  assert.deepEqual(sendTx.scrollIntent, { type: 'bottom' });
  assert.equal(store.state.statusKind, 'queued');

  // Native snapshot deduplicates unchanged messages and restores saved viewport until historyEnd.
  const assistantMsg = {
    id: 'msg_a1',
    type: 'assistant',
    time: { created: 100, completed: 200 },
    content: [{ type: 'text', text: 'Refactored.' }],
  };
  const snap1 = store.ingestHostMessage({
    type: 'transcript',
    messages: [
      { id: 'msg_1', type: 'user', text: 'Refactor webview', time: { created: 90 } },
      assistantMsg,
      { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
    ],
    inbox: [],
    states: [['msg_1', 'completed']],
  });
  assert.equal(store.state.submissions.has('msg_1'), false, 'delivered user removes pending submission');
  assert.ok(snap1.ops.some((op) => op.type === 'nativeIdle'), 'idle marker emits nativeIdle op');
  assert.equal(snap1.scrollIntent.type, 'restore', 'saved viewport is preserved across initial snapshot');

  // Identical snapshot produces no duplicate message ops.
  const snap2 = store.ingestHostMessage({
    type: 'transcript',
    partial: true,
    messages: [assistantMsg],
  });
  assert.equal(
    snap2.ops.filter((op) => op.type === 'nativeAssistantText').length,
    0,
    'unchanged native messages are skipped by signature'
  );

  // historyEnd consumes the initial restoredViewport once.
  const endTx = store.ingestHostMessage({ type: 'historyEnd' });
  assert.equal(endTx.scrollIntent.type, 'historyEnd');
  assert.deepEqual(endTx.scrollIntent.viewport, { bottom: false, anchor: 'm1:0', offset: 12 });
  assert.equal(store.hasRestoredViewport, false);
}

// 2. Transport status blips never settle live turn steps
{
  const store = createChatStore();
  store.ingestHostMessage({ type: 'status', state: 'busy' });
  const toolTx = store.ingestHostMessage({
    type: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', status: 'in_progress' },
  });
  assert.equal(toolTx.ops[0].type, 'upsertTool');

  const reconnectTx = store.ingestHostMessage({ type: 'status', state: 'connecting' });
  assert.equal(reconnectTx.ops.length, 0, 'reconnect status blip emits zero transcript ops');
}

// 3. Layer 0 pure metadata & formatting invariants
{
  assert.equal(formatTurnTokens(12345, 1000, 0, true), '11.3k tok (+1k cache read)');
  assert.equal(compactionThreshold(200000, 160000, { auto: true, buffer: 20000 }), 140000);
  assert.equal(compactionThreshold(200000, 0, { auto: false }), 0);

  const patches = permissionPatchOperations({
    patchText: [
      '*** Begin Patch',
      '*** Update File: src/old.js',
      '*** Move to: src/new.js',
      '*** Add File: src/added.js',
      '*** End Patch',
    ].join('\n'),
  });
  assert.deepEqual(patches, [
    { action: 'Rename', path: 'src/old.js', to: 'src/new.js' },
    { action: 'Create', path: 'src/added.js' },
  ]);

  const summary = summarizeTools(
    [
      { kind: 'read', statusValue: 'completed', activity: { rawInput: { path: 'src/a.js' } } },
      { kind: 'read', statusValue: 'completed', activity: { rawInput: { path: '/w/src/./a.js' } } },
      { kind: 'edit', statusValue: 'in_progress', activity: { rawInput: { path: 'src/b.js' } } },
    ],
    '/w'
  );
  assert.deepEqual(summary.metrics, ['Read 1 file']);
  assert.deepEqual(summary.statusMetrics, ['1 running']);

  const thought = { text: '```md\n# Ignored\n```\n## Inspecting scroll anchors\n', captionOffset: 0, captionFence: '', caption: '' };
  assert.equal(scanThoughtCaption(thought, false), 'Inspecting scroll anchors');

  const plan = planUsageParts(
    { windows: [{ kind: 'five_hour', used: 2700, limit: 12000, unit: 'credits', percentage: 22, resetsAt: 200000 }] },
    () => 'today 13:30',
    100000
  );
  assert.equal(plan.line, '1m ↻ 22%');
  assert.ok(plan.tooltip.includes('2.7k / 12k credits'));
}

// 4. Static architecture guard: Layer 2 views never directly mutate scrollTop
{
  const chatDir = path.join(__dirname, '../src/webview/chat');
  const viewFiles = [
    'transcript-renderer.js',
    'permissions-view.js',
    'composer-view.js',
    'usage-view.js',
    'header-view.js',
    'file-links-view.js',
  ];
  for (const file of viewFiles) {
    const raw = fs.readFileSync(path.join(chatDir, file), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\.scrollTop\s*[+-]?=/.test(code), `${file} must not write scrollTop directly`);
    assert.ok(!/scrollIntoView\s*\(/.test(code), `${file} must not call scrollIntoView`);
    assert.ok(!/scrollToBottom\s*\(/.test(code), `${file} must not contain ad-hoc scrollToBottom calls`);
  }
}

console.log('WEBVIEW ARCHITECTURE OK');

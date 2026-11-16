'use strict';

const assert = require('node:assert/strict');
const { updateThoughtBlock, thoughtCaption } = require('../src/thought-caption');
const { thoughtTranscript } = require('../src/thought-transcript');
const { ThoughtSummarizer } = require('../src/thought-summarizer');
const { createChatStore } = require('../src/webview/chat/store');

const block = (text, extra = {}, previous) => updateThoughtBlock(previous, {
  sessionId: 'ses_thought', turnId: 'user', id: 'assistant:0', text, completed: false, ...extra,
});

function clock() {
  let time = 0;
  let seq = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const id = ++seq; tasks.set(id, { fn, at: time + ms }); return id; },
    clearTimer: (id) => tasks.delete(id),
    advance(ms = 0) {
      time += ms;
      for (;;) {
        const due = [...tasks].find(([, task]) => task.at <= time);
        if (!due) break;
        tasks.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

module.exports = async function thoughtCaptionTests() {
  const short = block('Inspecting hash implementation');
  assert.equal(thoughtCaption(short), '', 'an unfinished short prefix is not a caption');
  const done = block(short.text, { completed: true }, short);
  assert.equal(thoughtCaption(done), short.text);
  assert.equal(updateThoughtBlock(done, done), done, 'unchanged snapshots preserve revision and identity');
  const heading = block('**Inspecting hash implementation**\n' + 'Details. '.repeat(40));
  assert.equal(thoughtCaption(heading), short.text);
  const replacement = block('Completely replaced text', {}, heading);
  assert.equal(replacement.caption, '', 'replacement must not retain a heading from the old text');
  assert.ok(replacement.epoch > heading.epoch);
  assert.equal(block('```md\n## Not a caption\n```', { completed: true }).caption, '');

  const source = [
    { id: 'user', type: 'user', text: 'Work', time: { created: 1 } },
    { id: 'assistant', type: 'assistant', time: { created: 2 }, content: [
      { type: 'reasoning', text: 'Inspecting hash implementation' },
      { type: 'reasoning', text: 'Locating namespace for driver' },
      { type: 'reasoning', text: 'Auditing input changes', streamCompleted: true },
    ] },
  ];
  const snapshot = thoughtTranscript(source, 'ses_thought');
  const thoughts = snapshot.messages[1].content.map((part) => part.thought);
  assert.ok(thoughts.every((thought) => thought.completed));
  assert.equal(snapshot.latest.caption, 'Auditing input changes', 'the last thought ends before the assistant message');
  assert.deepEqual(thoughtTranscript(snapshot.messages, 'ses_thought'), snapshot, 'replay is idempotent');

  const store = createChatStore();
  store.ingestHostMessage({ type: 'session', sessionId: 'ses_thought' });
  store.ingestHostMessage({ type: 'status', state: 'busy' });
  const tx = store.ingestHostMessage({ type: 'transcript', messages: snapshot.messages });
  assert.equal(store.state.activityThought, 'Auditing input changes');
  assert.equal(tx.ops.filter((op) => op.type === 'nativeThought').at(-1).block, snapshot.latest,
    'the renderer and caption projection consume the same canonical block');
  const long = block('Investigating dependencies. '.repeat(50), { id: 'assistant:3' });
  source[1].content.push({ type: 'reasoning', text: long.text, thought: long });
  store.ingestHostMessage({ type: 'transcript', messages: thoughtTranscript(source, 'ses_thought').messages });
  const summary = { ...long, text: 'Checking dependencies' };
  const restored = createChatStore();
  restored.ingestHostMessage({ type: 'transcript',
    messages: thoughtTranscript(source, 'ses_thought').messages, thoughtSummary: summary });
  restored.ingestHostMessage({ type: 'status', state: 'busy' });
  assert.equal(restored.state.activityThought, summary.text,
    'a snapshot received before busy restores its cached summary without another delta');
  store.ingestHostMessage({ type: 'thoughtCaption', summary });
  assert.equal(store.state.activityThought, 'Checking dependencies');
  const newer = block(long.text + ' More context.', { id: long.id }, long);
  source[1].content[3] = { type: 'reasoning', text: newer.text, thought: newer };
  store.ingestHostMessage({ type: 'transcript', messages: thoughtTranscript(source, 'ses_thought').messages });
  assert.equal(store.state.activityThought, 'Checking dependencies', 'appends retain a useful older summary');
  const summary2 = { ...newer, text: 'Validating dependencies' };
  store.ingestHostMessage({ type: 'thoughtCaption', summary: summary2 });
  store.ingestHostMessage({ type: 'thoughtCaption', summary });
  assert.equal(store.state.activityThought, 'Validating dependencies', 'out-of-order summaries cannot roll back the caption');
  source[1].content.push({ type: 'reasoning', text: 'Writing snapshot validator', streamCompleted: true });
  store.ingestHostMessage({ type: 'transcript', messages: thoughtTranscript(source, 'ses_thought').messages });
  store.ingestHostMessage({ type: 'thoughtCaption', summary: { ...summary2, text: 'Late result' } });
  assert.equal(store.state.activityThought, 'Writing snapshot validator');
  store.ingestHostMessage({ type: 'turnEnd' });
  store.ingestHostMessage({ type: 'thoughtCaption', summary: summary2 });
  assert.equal(store.state.activityThought, '', 'late results cannot revive a finished turn');
  store.ingestHostMessage({ type: 'status', state: 'busy' });
  assert.equal(store.state.activityThought, '', 'a new busy status cannot revive a finished caption');

  const acp = createChatStore();
  acp.ingestHostMessage({ type: 'status', state: 'busy' });
  const chunk = (text) => acp.ingestHostMessage({ type: 'update', update: {
    sessionUpdate: 'agent_thought_chunk', messageId: 'same-message', content: { type: 'text', text },
  } });
  const tool = (id) => acp.ingestHostMessage({ type: 'update', update: {
    sessionUpdate: 'tool_call', toolCallId: id, title: 'read', kind: 'read', status: 'in_progress',
  } });
  chunk('Inspecting hash implementation');
  tool('one');
  chunk('Auditing input changes');
  tool('two');
  assert.equal(acp.state.activityThought, 'Auditing input changes', 'ACP blocks within one message keep separate identities');
  assert.equal(acp.state.thoughtBlocks.size, 2);
  const synthetic = createChatStore();
  synthetic.ingestHostMessage({ type: 'status', state: 'busy' });
  const resumed = thoughtTranscript([...snapshot.messages,
    { id: 'idle', type: 'idle' },
    { id: 'resumed', type: 'assistant', time: {}, content: [
      { type: 'reasoning', text: 'Checking resumed work', streamCompleted: true },
    ] },
  ], 'ses_thought');
  synthetic.ingestHostMessage({ type: 'transcript', messages: resumed.messages });
  assert.equal(synthetic.state.activityThought, 'Checking resumed work',
    'a server-resumed turn after idle does not inherit the prior thought identity');

  const timers = clock();
  const calls = [];
  const results = [];
  const summarize = (request) => new Promise((resolve, reject) => calls.push({ request, resolve, reject }));
  const worker = new ThoughtSummarizer({ ...timers, summarize, publish: (value) => results.push(value), maxChars: 200 });
  worker.update(done);
  timers.advance();
  assert.equal(calls.length, 0, 'completed short thoughts bypass the provider');
  worker.update(heading);
  timers.advance();
  assert.equal(calls.length, 0, 'explicit headings bypass the provider while streaming');
  worker.update(long);
  timers.advance();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.text.length, 200, 'only a bounded excerpt reaches the provider');
  worker.update(newer);
  calls[0].resolve('Inspecting dependencies');
  await flush();
  assert.equal(results[0].revision, long.revision, 'same-block appends do not starve valid results');
  for (let i = 1; i <= 10; i++) {
    worker.update(block(newer.text + 'x'.repeat(i), { id: long.id }, newer));
    timers.advance(100);
  }
  assert.equal(calls.length, 2, 'a continuous stream still triggers the fixed update deadline');
  worker.update(block('Writing snapshot validator', { id: 'next', completed: true }));
  assert.equal(calls[1].request.signal.aborted, true);
  calls[1].resolve('Obsolete summary');
  await flush();
  assert.equal(results.length, 1, 'new direct captions invalidate in-flight results');

  worker.update(block('Other long thought. '.repeat(40), { id: 'another' }));
  timers.advance(1000);
  assert.equal(calls.length, 3);
  worker.update(null);
  calls[2].resolve('After idle');
  await flush();
  assert.equal(results.length, 1, 'idle invalidates in-flight results');

  worker.update(long);
  timers.advance(1000);
  assert.equal(calls.length, 4);
  calls[3].reject(new Error('Provider unavailable'));
  await flush();
  timers.advance(10000);
  assert.equal(calls.length, 4, 'a failure does not create a retry loop');
  worker.update(newer);
  timers.advance();
  assert.equal(calls.length, 5, 'new input can recover after failure');
  timers.advance(10000);
  assert.equal(calls[4].request.signal.aborted, true, 'requests have a deadline');
  worker.update(block('New work. '.repeat(40), { id: 'new' }));
  timers.advance(1000);
  assert.equal(calls.length, 5, 'even an abort-ignoring provider cannot create overlapping requests');
  calls[4].resolve('Too late');
  await flush();
  timers.advance();
  assert.equal(calls.length, 6, 'only the latest queued input runs after the old request settles');
  worker.dispose();
  calls[5].resolve('After disposal');
  await flush();
  assert.equal(results.length, 1);
  console.log('Thought captions: canonical blocks, replay, stale results and scheduler OK');
};

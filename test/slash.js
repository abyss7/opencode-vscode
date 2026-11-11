'use strict';

const assert = require('node:assert');

class ClassList {
  constructor(element) {
    this.element = element;
  }

  _values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  _write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...names) {
    const values = this._values();
    for (const name of names) values.add(name);
    this._write(values);
  }

  remove(...names) {
    const values = this._values();
    for (const name of names) values.delete(name);
    this._write(values);
  }

  contains(name) {
    return this._values().has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parent = null;
    this.className = '';
    this._text = '';
    this.hidden = false;
    this.open = false;
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = String(value); } };
    this.attributes = {};
    this.title = '';
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.scrollTop = 0;
    this.innerHTML = '';
    this.classList = new ClassList(this);
    this.listeners = {};
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text || this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(value) {
    this._html = String(value);
    this._text = String(value).replace(/<[^>]*>/g, '');
    this.children = [];
  }

  get innerHTML() {
    return this._html || '';
  }

  appendChild(child) {
    if (child.parent && child.parent !== this) {
      const index = child.parent.children.indexOf(child);
      if (index >= 0) child.parent.children.splice(index, 1);
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  prepend(...children) {
    for (const child of children.slice().reverse()) {
      if (child.parent) {
        const index = child.parent.children.indexOf(child);
        if (index >= 0) child.parent.children.splice(index, 1);
      }
      child.parent = this;
      this.children.unshift(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this._text = '';
    this.append(...children);
  }

  addEventListener(name, listener) {
    if (!this.listeners[name]) this.listeners[name] = [];
    this.listeners[name].push(listener);
  }

  emit(name, event) {
    const payload = Object.assign({ preventDefault() {}, target: this }, event);
    for (const listener of this.listeners[name] || []) listener(payload);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  removeAttribute(name) { delete this.attributes[name]; }

  getAttribute(name) { return this.attributes[name] ?? null; }

  setSelectionRange() {}

  focus() {
    this.focused = true;
  }

  getBoundingClientRect() { return { top: 0, bottom: 100, height: 100 }; }
  getContext() { return null; }

  contains(node) { return node === this || this.children.some(child => child.contains(node)); }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = null;
  }

  insertBefore(node, before) {
    node.remove();
    const index = this.children.indexOf(before);
    if (index < 0) return this.appendChild(node);
    node.parent = this;
    this.children.splice(index, 0, node);
    return node;
  }

  get parentElement() { return this.parent; }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }

  matches(selector) {
    if (selector.startsWith(':scope > ')) {
      const rest = selector.slice(9);
      if (!rest.startsWith('.')) return false;
      const expected = rest.slice(1).split('.').filter(Boolean);
      const actual = this.className.split(/\s+/).filter(Boolean);
      return expected.every((name) => actual.includes(name));
    }
    if (!selector.startsWith('.')) return this.tagName === selector;
    const expected = selector.slice(1).split('.').filter(Boolean);
    const actual = this.className.split(/\s+/).filter(Boolean);
    return expected.every((name) => actual.includes(name));
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const ids = {};
for (const id of [
  'messages',
  'empty',
  'input',
  'composer',
  'composer-controls',
  'questions',
  'send',
  'stop',
  'status',
  'status-text',
  'activity-detail',
  'activity-operation',
  'activity-target',
  'activity-jump',
  'usage',
  'usage-cost',
  'usage-reset',
  'attachments',
  'config-bar',
  'slash-menu',
]) {
  ids[id] = new Element('div');
}
ids.input.tagName = 'textarea';
ids.send.tagName = 'button';
ids.stop.tagName = 'button';
ids.questions.hidden = true;
const usageThreshold = new Element('span');
usageThreshold.className = 'usage-threshold';
usageThreshold.hidden = true;
ids.usage.append(usageThreshold);

const posted = [];
let handler = null;

global.acquireVsCodeApi = () => ({
  postMessage: (message) => posted.push(message),
  setState: () => {},
});
global.document = {
  body: new Element('body'),
  compatMode: 'CSS1Compat',
  title: '',
  getElementById: (id) => ids[id],
  // This harness keeps document roots in the ID registry rather than body.
  querySelectorAll: (selector) => [...new Set(Object.values(ids).flatMap((root) => [
    ...(root.matches(selector) ? [root] : []),
    ...root.querySelectorAll(selector),
  ]))],
  createElement: (tagName) => new Element(tagName),
  addEventListener: () => {},
};
global.window = {
  addEventListener: (name, listener) => {
    if (name === 'message') handler = listener;
  },
};
global.Element = Element;
global.window.MutationObserver = class { observe() {} };
global.MutationObserver = global.window.MutationObserver;
global.ResizeObserver = class { observe() {} unobserve() {} };
// This is a synchronous command/DOM harness; geometry and observer delivery
// are exercised by the browser scroll architecture tests.
global.requestAnimationFrame = () => 1;
global.getComputedStyle = () => ({ getPropertyValue: () => '', fontFamily: 'monospace' });
global.OpenCodeRichText = require('../media/rich-text.js');

require('../media/chat.js');

const send = (message) => handler({ data: message });
const type = (value) => {
  ids.input.value = value;
  ids.input.emit('input');
};
const rows = () => ids['slash-menu'].children;
const rowName = (index) => rows()[index].querySelector('.slash-name').textContent;

function start() {
  send({ type: 'status', state: 'ready' });
  send({ type: 'session', sessionId: 'ses_test', cwd: '/tmp', loaded: false });
  send({ type: 'capabilities', images: true });
  send({
    type: 'slashItems',
    skills: [{ id: 'handoff', name: 'handoff', description: 'Save task notes' }],
    commands: [{ name: 'review', description: 'review changes' }],
  });
  send({
    type: 'update',
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'init', description: 'guided AGENTS.md setup' },
        { name: 'review', description: 'review changes' },
        { name: 'goal', description: 'keep working' },
        { name: 'compact', description: 'Compact the session' },
      ],
    },
  });
  send({ type: 'historyEnd' });
}

start();

// The menu opens on a leading slash and merges ACP commands with REST commands and skills.
type('/');
assert.strictEqual(ids['slash-menu'].hidden, false);
assert.strictEqual(rows().length, 5);
assert.strictEqual(rowName(0), '/init');
assert.strictEqual(rows()[4].querySelector('.slash-kind').textContent, 'skill');

// Prefix filtering keeps only matching entries.
type('/re');
assert.strictEqual(rows().length, 1);
assert.strictEqual(rowName(0), '/review');
ids.input.emit('keydown', { key: 'Enter' });
assert.strictEqual(ids.input.value, '/review ');
assert.strictEqual(ids['slash-menu'].hidden, true);

// Skills are inserted as @ mentions.
type('/hand');
assert.strictEqual(rows().length, 1);
assert.strictEqual(rowName(0), '@handoff');
ids.input.emit('keydown', { key: 'Enter' });
assert.strictEqual(ids.input.value, '@handoff ');

// Arrow keys move the selection and Escape closes the menu.
type('/');
ids.input.emit('keydown', { key: 'ArrowDown' });
assert.strictEqual(rows()[1].classList.contains('selected'), true);
ids.input.emit('keydown', { key: 'Escape' });
assert.strictEqual(ids['slash-menu'].hidden, true);

// A known command is sent as a command, not as a plain prompt.
posted.length = 0;
type('/review commit');
assert.strictEqual(ids['slash-menu'].hidden, true);
ids.input.emit('keydown', { key: 'Enter' });
const command = posted.find((message) => message.type === 'command');
assert.ok(command, 'expected a command message');
assert.strictEqual(command.name, 'review');
assert.strictEqual(command.text, 'commit');
assert.strictEqual(posted.some((message) => message.type === 'prompt'), false);

// Plain text still goes through the prompt path.
posted.length = 0;
send({ type: 'status', state: 'ready' });
type('hello there');
ids.input.emit('keydown', { key: 'Enter' });
assert.ok(posted.some((message) => message.type === 'prompt' && message.text === 'hello there'));

// After a command the transcript is reloaded; the expanded template must not duplicate the echo.
const beforeReset = ids.messages.querySelectorAll('.message').filter((node) => node.classList.contains('user'));
assert.strictEqual(beforeReset.length, 2);
send({ type: 'status', state: 'busy' });
send({ type: 'historyReset' });
send({ type: 'update', update: { sessionUpdate: 'user_message_chunk', messageId: 'u_cmd', content: { type: 'text', text: 'Create or update AGENTS.md ... expanded' } } });
send({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a_cmd', content: { type: 'text', text: 'done' } } });
send({ type: 'update', update: { sessionUpdate: 'user_message_chunk', messageId: 'u_old', content: { type: 'text', text: 'hello there' } } });
send({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a_old', content: { type: 'text', text: 'old answer' } } });
const draft = ids.messages
  .querySelectorAll('.message.assistant')
  .map((node) => node.textContent)
  .join('|');
assert.strictEqual(draft.includes('old answer'), false, 'answer must stay hidden until the message is complete');
send({ type: 'historyEnd' });
const visibleAssistant = ids.messages
  .querySelectorAll('.message.assistant')
  .filter((node) => node.hidden === false);
assert.ok(visibleAssistant.length > 0, 'completed answer must become visible');
send({ type: 'turnEnd', stopReason: 'end_turn' });

const users = ids.messages.querySelectorAll('.message').filter((node) => node.classList.contains('user'));
assert.strictEqual(users.length, 2);
assert.ok(users[0].textContent.includes('/review commit'));
assert.ok(users[1].textContent.includes('hello there'));
const assistantText = ids.messages
  .querySelectorAll('.message.assistant')
  .map((node) => node.textContent)
  .join('|');
assert.ok(assistantText.includes('done'));
assert.ok(assistantText.includes('old answer'));

// File references in answers are candidates that become links only after validation.
send({ type: 'historyReset' });
send({
  type: 'update',
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a_links',
    content: {
      type: 'text',
      text:
        'Opened `src/api.js:42`, [the panel](src/session-panel.js#L190) and ' +
        '/abs/path/file.ts:7:3. Also package.json, but not https://example.com/a.ts:9.',
    },
  },
});
send({ type: 'historyEnd' });
const linkBody = ids.messages
  .querySelectorAll('.message.assistant')
  .filter((node) => node.hidden === false)
  .pop()
  .querySelector('.md');
const linkHtml = linkBody.innerHTML;
assert.ok(linkHtml.includes('data-file="src/api.js"'), 'a code path must be a candidate');
assert.ok(linkHtml.includes('data-line="42"'), 'the code path must keep its line');
assert.ok(
  linkHtml.includes('data-file="src/session-panel.js"') && linkHtml.includes('data-line="190"'),
  'a markdown link to a file must be a candidate'
);
assert.ok(
  linkHtml.includes('data-file="/abs/path/file.ts"') &&
    linkHtml.includes('data-line="7"') &&
    linkHtml.includes('data-column="3"'),
  'an absolute path must keep line and column'
);
assert.ok(linkHtml.includes('data-file="package.json"'), 'a bare file name must be a candidate');
assert.ok(!linkHtml.includes('data-file="https'), 'a URL must not become a file candidate');

// Only confirmed files turn into links; unknown paths stay plain text.
const missingCandidate = document.createElement('span');
missingCandidate.className = 'file-ref';
missingCandidate.dataset.file = 'no/such.ts';
missingCandidate.dataset.line = '3';
ids.messages.appendChild(missingCandidate);
send({ type: 'fileChecks', files: [{ key: 'no/such.ts\u00003\u0000', exists: false }] });
assert.strictEqual(missingCandidate.classList.contains('file-link'), false);

const realCandidate = document.createElement('span');
realCandidate.className = 'file-ref';
realCandidate.dataset.file = 'src/api.js';
ids.messages.appendChild(realCandidate);
send({ type: 'fileChecks', files: [{ key: 'src/api.js\u0000\u0000', exists: true }] });
assert.strictEqual(realCandidate.classList.contains('file-link'), true);

// A running shell command is shown as a short prefix, not as the whole command.
send({ type: 'status', state: 'busy' });
const longCommand = 'echo ' + 'x'.repeat(300);
send({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 't_long',
    kind: 'execute',
    title: 'shell',
    status: 'in_progress',
    rawInput: { command: longCommand },
  },
});
const steps = ids.messages.querySelector('.turn-steps');
assert.ok(steps, 'turn steps expected');
const liveText = ids['activity-target'].textContent;
assert.strictEqual(liveText.length, 121);
assert.strictEqual(liveText.endsWith('…'), true);
assert.strictEqual(liveText.includes('x'.repeat(200)), false);

// Focusing the session tab scrolls to the bottom and puts the caret in the composer.
ids.messages.scrollTop = 0;
ids.input.focused = false;
send({ type: 'focus' });
assert.strictEqual(ids.messages.scrollTop, ids.messages.scrollHeight);
assert.strictEqual(ids.input.focused, true);

// The context meter tooltip shows exact counts, without repeating the capacity.
send({ type: 'compaction', compaction: { auto: true, buffer: 800000 } });
send({ type: 'turnEnd', stopReason: 'end_turn', usage: { used: 120000, size: 1048576 } });
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 120,000 tokens\nContext capacity: 1,048,576 tokens\nCompaction threshold: 248,576 tokens'
);

// Without a configured buffer the server default is 15% of the window.
send({ type: 'compaction', compaction: { auto: true } });
send({ type: 'turnEnd', stopReason: 'end_turn', usage: { used: 120000, size: 200000 } });
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 120,000 tokens\nContext capacity: 200,000 tokens\nCompaction threshold: 170,000 tokens'
);

// Automatic compaction off hides the tick and explains the disabled state.
send({ type: 'compaction', compaction: { auto: false } });
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 120,000 tokens\nContext capacity: 200,000 tokens\nAutomatic compaction: disabled'
);
assert.strictEqual(usageThreshold.hidden, true);

// Restored usage from history is exact as stored, so it carries no estimate mark.
send({ type: 'compaction', compaction: { auto: true, buffer: 800000 } });
send({
  type: 'update',
  update: { sessionUpdate: 'usage_update', used: 90000, size: 1048576 },
});
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 90,000 tokens\nContext capacity: 1,048,576 tokens\nCompaction threshold: 248,576 tokens'
);
send({
  type: 'update',
  update: { sessionUpdate: 'usage_update', used: 91000, size: 1048576 },
});
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 91,000 tokens\nContext capacity: 1,048,576 tokens\nCompaction threshold: 248,576 tokens'
);

// The provider input window wins over the context window.
send({ type: 'compaction', compaction: { auto: true, buffer: 20000 } });
send({ type: 'modelLimit', context: 200000, input: 160000 });
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 91,000 tokens\nContext capacity: 160,000 tokens\nCompaction threshold: 140,000 tokens'
);
assert.strictEqual(ids.usage.textContent, '');
assert.strictEqual(ids.usage.getAttribute('aria-valuemax'), '160000');
assert.strictEqual(ids.usage.style['--context-used'], '56.875%');
assert.strictEqual(usageThreshold.hidden, false);

// Cost adds direct sub-agent spending and shows the DeepSeek balance.
send({
  type: 'turnEnd',
  stopReason: 'end_turn',
  usage: { used: 92000, size: 200000, cost: { amount: 0.5, currency: 'USD' } },
});
assert.strictEqual(ids['usage-cost'].textContent, 'cost: $0.5000');
send({ type: 'subagents', items: [], totalCost: 0.25 });
assert.strictEqual(
  ids['usage-cost'].textContent,
  'cost: $0.7500 (sub-agents $0.2500)'
);
send({ type: 'balance', balance: { amount: 13.65, currency: 'USD' } });
assert.strictEqual(
  ids['usage-cost'].textContent,
  'cost: $0.7500 (sub-agents $0.2500) · balance: $13.65'
);
send({ type: 'balance', balance: null });
send({ type: 'subagents', items: [], totalCost: 0 });

// The cost tooltip splits the session spend by tariff. Only the totals are
// printed; the per-message costs stay internal.
assert.strictEqual(ids['usage-cost'].title, 'Spent cost and remaining budget');
send({
  type: 'costSplit',
  total: 0.42,
  rows: [
    { key: 'input', label: 'input', tokens: 808027, cost: 0.1212 },
    { key: 'output', label: 'output (incl. reasoning)', tokens: 254786, cost: 0.1529 },
    { key: 'cacheRead', label: 'cache read', tokens: 48761984, cost: 0.1463 },
    { key: 'cacheWrite', label: 'cache write', tokens: 0, cost: 0 },
  ],
});
assert.strictEqual(
  ids['usage-cost'].title,
  [
    'Spent $0.4200',
    '  · $0.1212  input',
    '  · $0.1529  output (incl. reasoning)',
    '  · $0.1463  cache read',
  ].join('\n')
);
send({ type: 'subagents', items: [], totalCost: 0.25 });
assert.ok(
  ids['usage-cost'].title.endsWith('  · $0.2500  sub-agents'),
  'sub-agent spending closes the tooltip'
);
assert.strictEqual(
  ids['usage-cost'].textContent,
  'cost: $0.7500 (sub-agents $0.2500)',
  'the visible line is unchanged'
);
send({ type: 'subagents', items: [], totalCost: 0 });

// Amounts keep their decimal separators in one column, however wide they get.
send({
  type: 'costSplit',
  total: 12.5,
  rows: [
    { key: 'input', label: 'input', tokens: 1000, cost: 0.1212 },
    { key: 'cacheRead', label: 'cache read', tokens: 2000, cost: 12.3456 },
  ],
});
assert.strictEqual(
  ids['usage-cost'].title,
  ['Spent $12.5000', '  ·  $0.1212  input', '  · $12.3456  cache read'].join('\n')
);
send({ type: 'costSplit', total: 0.42, rows: [] });
assert.strictEqual(ids['usage-cost'].title, 'Spent cost and remaining budget');

// Budget remaining is resolved for the selected model by the extension.
send({
  type: 'limits',
  limits: null,
  budget: {
    id: 'b1',
    limit: 10,
    spent: 3,
    remaining: 7,
    modelMatched: true,
    label: 'DeepSeek Flash',
    resetsAt: Date.now() + 3600000,
  },
});
assert.strictEqual(ids['usage-cost'].textContent, 'cost: $0.5000 · $7.00 left for DeepSeek Flash');
assert.ok(ids['usage-reset'].textContent.startsWith('reset in '));

// The end-of-turn result replaces the estimate in the newest turn block.
send({ type: 'status', state: 'busy' });
send({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 't_billed',
    kind: 'read',
    title: 'read',
    status: 'completed',
  },
});
send({
  type: 'update',
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a_billed',
    content: { type: 'text', text: 'exact' },
  },
});
send({
  type: 'turnEnd',
  stopReason: 'end_turn',
  usage: {
    used: 93000,
    size: 200000,
    totalTokens: 12345,
    inputTokens: 12000,
    outputTokens: 345,
    thoughtTokens: 0,
    cachedReadTokens: 1000,
    cachedWriteTokens: 0,
  },
});
const billedBlock = ids.messages.querySelectorAll('.turn-steps').pop();
const billedTokens = billedBlock.querySelector('.tokens');
assert.strictEqual(
  billedTokens.textContent,
  '11.3k tok (+1k cache read)',
  'the header shows the uncached part and the cached addition'
);
assert.strictEqual(billedBlock.dataset.exact, '1');
assert.ok(billedTokens.title.startsWith('Billed tokens for this turn: input 12k'));
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 93,000 tokens\nContext capacity: 160,000 tokens\nCompaction threshold: 140,000 tokens'
);

// A turn without its own steps must not overwrite an older turn block.
send({
  type: 'turnEnd',
  stopReason: 'end_turn',
  usage: { used: 94000, size: 200000, totalTokens: 999 },
});
assert.strictEqual(
  billedBlock.querySelector('.tokens').textContent,
  '11.3k tok (+1k cache read)',
  'billed usage applies only to the block of the current turn'
);

// The session bar reports the cached share of the last prompt and when it was
// measured; the numbers come from the stored counters, not from an estimate.
send({
  type: 'cacheStats',
  prompt: 120000,
  input: 5000,
  read: 115000,
  write: 0,
  at: Date.now() - 2 * 3600 * 1000,
});
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 120,000 tokens\nContext capacity: 160,000 tokens\nCached context: 115,000 tokens (95.833% of current context; measured 2 hours ago)\nCompaction threshold: 140,000 tokens'
);
assert.strictEqual(ids.usage.style['--context-used'], '75%');
assert.strictEqual(ids.usage.style['--context-cached'], '71.875%');

// The share keeps three decimals: a nearly full cache must not round up to 100%.
send({
  type: 'cacheStats',
  prompt: 8000,
  input: 1,
  read: 7999,
  write: 0,
  at: 0,
});
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 8,000 tokens\nContext capacity: 160,000 tokens\nCached context: 7,999 tokens (99.987% of current context)\nCompaction threshold: 140,000 tokens'
);

// 100% is printed only when the whole prompt came from the cache.
send({ type: 'cacheStats', prompt: 5000, input: 0, read: 5000, write: 0, at: 0 });
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 5,000 tokens\nContext capacity: 160,000 tokens\nCached context: 5,000 tokens (100% of current context)\nCompaction threshold: 140,000 tokens'
);

// Without a known measurement time only the share is printed.
send({ type: 'cacheStats', prompt: 50000, input: 50000, read: 0, write: 0, at: 0 });
assert.strictEqual(
  ids.usage.getAttribute('aria-label'),
  'Context used: 50,000 tokens\nContext capacity: 160,000 tokens\nCached context: 0 tokens (0% of current context)\nCompaction threshold: 140,000 tokens'
);
send({ type: 'cacheStats' });

// Restored turns are exact too: the stored counters replace the estimate and
// the cache split is shown without the `~` mark.
send({ type: 'status', state: 'busy' });
send({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 't_restored',
    kind: 'read',
    title: 'read',
    status: 'completed',
  },
});
send({ type: 'turnEnd', stopReason: 'end_turn' });
send({
  type: 'turnStats',
  scope: 'last',
  turns: [
    {
      steps: 2,
      tokens: 12345,
      kinds: ['read'],
      exact: true,
      cacheRead: 11000,
      cacheWrite: 0,
    },
  ],
});
const restoredBlock = ids.messages.querySelectorAll('.turn-steps').pop();
assert.strictEqual(
  restoredBlock.querySelector('.tokens').textContent,
  '1.3k tok (+11k cache read)'
);
assert.strictEqual(restoredBlock.dataset.exact, '1');

// An answer closes the chevron: the text is printed in the transcript and the
// steps after it start a new block, so nothing of the answer stays collapsed.
send({ type: 'status', state: 'busy' });
send({
  type: 'update',
  update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u_split',
    content: { type: 'text', text: 'split turn' },
  },
});
send({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 't_split1',
    kind: 'read',
    title: 'read',
    status: 'completed',
  },
});
send({
  type: 'update',
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a_split1',
    content: { type: 'text', text: 'first answer' },
  },
});
send({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 't_split2',
    kind: 'read',
    title: 'read',
    status: 'completed',
  },
});
send({
  type: 'update',
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a_split2',
    content: { type: 'text', text: 'second answer' },
  },
});
send({ type: 'turnEnd', stopReason: 'end_turn' });

const splitBlocks = ids.messages.querySelectorAll('.turn-steps');
const splitPair = splitBlocks.slice(-2);
assert.strictEqual(splitPair.length, 2, 'steps after an answer must open a new chevron');
assert.strictEqual(splitPair[0].dataset.turn, splitPair[1].dataset.turn);
assert.ok(splitPair[0] !== splitPair[1]);
for (const block of splitPair) {
  assert.strictEqual(
    block.querySelectorAll('.message.assistant').length,
    0,
    'answer text must stay outside the chevron'
  );
}
const splitText = ids.messages
  .querySelectorAll('.message.assistant')
  .filter((node) => node.hidden === false)
  .map((node) => node.textContent)
  .join('|');
assert.ok(splitText.includes('first answer'));
assert.ok(splitText.includes('second answer'));

// A turn that ends without text is explained instead of leaving a blank screen.
send({ type: 'status', state: 'busy' });
send({
  type: 'update',
  update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u_silent',
    content: { type: 'text', text: 'silent turn' },
  },
});
send({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 't_silent',
    kind: 'read',
    title: 'read',
    status: 'completed',
  },
});
send({ type: 'turnEnd', stopReason: 'end_turn' });
const silentBlock = ids.messages.querySelectorAll('.turn-steps').pop();
assert.strictEqual(silentBlock.open, true, 'the only chevron is opened when there is no answer');
assert.ok(
  ids.messages
    .querySelectorAll('.info')
    .some((node) => node.textContent.includes('No text answer in this turn')),
  'a turn without text must say so'
);

// A turn that produced nothing at all names the stop reason; it must not also
// print the generic cancellation line.
send({ type: 'status', state: 'busy' });
send({
  type: 'update',
  update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u_none',
    content: { type: 'text', text: 'no work' },
  },
});
send({ type: 'turnEnd', stopReason: 'cancelled' });
const notices = ids.messages.querySelectorAll('.info').map((node) => node.textContent);
assert.ok(notices.includes('The turn was stopped before the model wrote an answer.'));
assert.ok(!notices.includes('Stopped by user.'), 'the notice must not be duplicated');

console.log('SLASH OK');

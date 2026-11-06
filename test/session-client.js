'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { SessionClient, toolUpdate, formSchema, formAnswer } = require('../src/session-client');
const { ServerEvents } = require('../src/server-events');

const questionFields = () => [{ key: 'q0', title: 'Запуск проверок', description: 'Можно ли выполнить?',
  type: 'string', custom: true,
  options: [{ value: 'Да', label: 'Да', description: 'Запустить' }, { value: 'Нет', label: 'Нет' }] }];

// Native selects and the question tool's free-form answer must survive the
// translation to the elicitation schema the webview renders.
const questionSchema = formSchema(questionFields());
assert.deepEqual(questionSchema.properties.q0.oneOf.map((option) => option.const), ['Да', 'Нет']);
assert.ok(!('enum' in questionSchema.properties.q0), 'choices use oneOf so labels stay visible');
assert.deepEqual(questionSchema.properties.q0_custom,
  { type: 'string', title: 'Запуск проверок (other)', description: 'Type your own answer' });
assert.deepEqual(formAnswer(questionFields(), { q0: 'Да', q0_custom: '' }), { q0: 'Да' });
assert.deepEqual(formAnswer(questionFields(), { q0_custom: 'Свой вариант' }), { q0: 'Свой вариант' });
assert.ok(!('q0_custom' in formSchema([{ ...questionFields()[0], custom: false }]).properties));

const multi = [{ key: 'q0', title: 'Шаги', type: 'multiselect', custom: true,
  options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }];
assert.deepEqual(formSchema(multi).properties.q0.items.anyOf.map((option) => option.const), ['a', 'b']);
assert.deepEqual(formAnswer(multi, { q0: ['a'], q0_custom: 'c' }), { q0: ['a', 'c'] });
assert.deepEqual(formAnswer(multi, { q0_custom: 'c' }), { q0: ['c'] });
assert.deepEqual(formAnswer([{ key: 'hidden', type: 'string', hidden: true, default: 'x' }], {}),
  { hidden: 'x' });
assert.equal(formSchema([{ key: 'q0', title: 't', type: 'string', required: true, custom: true,
  options: [{ value: 'a', label: 'A' }] }]).properties.q0_custom, undefined,
'a required choice cannot be replaced by a free-form answer');

function fixture() {
  const data = { history: [], inbox: [], permissions: [], forms: [], activity: 'running', calls: [] };
  const api = {
    listAllMessages: async () => structuredClone(data.history),
    listMessages: async () => structuredClone(data.history).reverse(),
    getSession: async () => ({ id: 'ses_test', _activity: data.activity, time: {} }),
    getMessage: async (sessionID, messageID) => structuredClone(data.messages?.[messageID] ?? null),
    _request: async (method, path, body) => {
      data.calls.push({ method, path, body });
      if (method === 'GET') {
        if (path.endsWith('/inbox')) return { data: data.inbox };
        if (path.startsWith('/api/permission/request?')) return { data: data.permissions };
        if (path.startsWith('/api/form?')) return { data: data.forms };
      }
      if (path.endsWith('/prompt')) {
        const item = { id: body.id, type: 'user', payload: { text: body.text }, time: { created: 2 } };
        data.inbox.push(item);
        if (data.lostResponse) throw new Error('Connection reset after durable admission');
        return { data: item };
      }
      return { data: [] };
    },
    interruptSession: async () => { data.interrupted = true; },
  };
  const client = new SessionClient({ api, cwd: '/work' });
  client.sessionId = 'ses_test';
  client.connected = true;
  client.schedule = () => {};
  client.on('transcript', (snapshot) => { data.snapshot = snapshot; });
  client.on('activity', (activity) => { data.reported = activity; });
  return { client, data, api };
}

const user = (id) => ({ id, type: 'user', text: id, time: { created: 1 } });
const assistant = (content, completed) => ({ id: 'msg_answer', type: 'assistant',
  time: { created: 2, ...(completed ? { completed: 3 } : {}) }, content });

(async () => {
  const config = fixture();
  config.api.listModels = async () => [];
  config.api.getDefaultModel = async () => null;
  config.api.listAgents = async () => [
    { id: 'hidden', name: 'Hidden', mode: 'primary', hidden: true },
    { id: 'explore', name: 'Explore', mode: 'subagent' },
    { id: 'custom', name: 'Custom default', mode: 'all' },
    { id: 'build', name: 'Build', mode: 'primary' },
  ];
  await config.client.refreshConfig();
  assert.equal(config.client.configOptions[0].currentValue, 'custom',
    'sessions without an override use the server-ordered default, not a hardcoded Build');
  assert.deepEqual(config.client.configOptions[0].options.map((option) => option.value), ['custom', 'build']);
  config.api.getSession = async () => ({ agent: 'build' });
  await config.client.refreshConfig();
  assert.equal(config.client.configOptions[0].currentValue, 'build', 'explicit session selection overrides the default');
  config.api.getSession = async () => ({});
  config.api.listAgents = async () => [];
  await config.client.refreshConfig();
  assert.equal(config.client.configOptions[0].currentValue, undefined, 'an unavailable catalog must not invent an agent');

  const { client, data } = fixture();
  data.history = [user('msg_first'), assistant([{ type: 'reasoning', text: '' }, { type: 'text', text: '' }])];
  data.inbox = [{ id: 'msg_next', type: 'user', payload: { text: 'Next' }, time: { created: 3 } }];
  const event = (type, more) => client.onEvent({ type, data: {
    sessionID: 'ses_test', assistantMessageID: 'msg_answer', ordinal: 0, ...more,
  } });
  event('session.reasoning.started');
  event('session.reasoning.delta', { delta: 'Thinking' });
  event('session.text.started');
  event('session.text.delta', { delta: 'Hello' });
  await client.reconcile();
  assert.deepEqual(data.snapshot.messages[1].content.map((p) => p.text), ['Thinking', 'Hello']);
  assert.equal(new Map(data.snapshot.states).get('msg_next'), 'queued');
  assert.equal(new Map(data.snapshot.states).get('msg_first'), 'running');
  await client.reconcile();
  assert.equal(data.snapshot.messages.length, 0, 'unchanged snapshots are not sent again');
  event('session.text.delta', { delta: ' world' });
  await client.reconcile();
  assert.equal(data.snapshot.messages[0].content[1].text, 'Hello world');
  client.liveText.clear(); // reconnect: no replay of missed deltas
  client.full = true;
  event('session.text.delta', { delta: ' missed prefix' });
  await client.reconcile();
  assert.equal(client.messages.get('msg_answer').content[1].text, 'Hello world', 'never append an unknown suffix after reconnect');
  event('session.text.ended', { text: 'Hello world recovered' });
  await client.reconcile();
  assert.equal(client.messages.get('msg_answer').content[1].text, 'Hello world recovered');
  data.history = [user('msg_first'), assistant([{ type: 'text', text: 'Done' }], true),
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 4 } }];
  data.activity = 'idle';
  client.full = true;
  await client.reconcile();
  assert.equal(new Map(data.snapshot.states).get('msg_first'), 'completed');
  assert.equal(data.reported, 'queued', 'an idle execution does not erase queued work');
  data.history.push(user('msg_next'), { id: 'msg_idle2', type: 'idle', outcome: 'failed', time: { created: 6 } });
  data.inbox = [];
  await client.reconcile();
  assert.equal(new Map(data.snapshot.states).get('msg_next'), 'failed');
  assert.equal(data.reported, 'idle');

  const race = fixture();
  race.data.activity = 'idle';
  race.api.listAllMessages = async () => {
    race.client.onEvent({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_test' } });
    return [user('msg_race')];
  };
  await race.client.reconcile();
  assert.equal(race.data.snapshot.partial, true, 'a racing admission invalidates inbox and completion state');
  assert.equal(race.data.reported, undefined, 'stale idle must never finish an admitted input');

  const lost = fixture();
  lost.data.lostResponse = true;
  await assert.rejects(lost.client.prompt([{ type: 'text', text: 'Queued image' },
    { type: 'image', mimeType: 'image/png', data: 'AA==' }], { id: 'msg_stable' }));
  assert.equal(lost.client.submissions.get('msg_stable').state, 'unknown');
  await lost.client.reconcile();
  assert.equal(lost.client.submissions.size, 0);
  assert.equal(new Map(lost.data.snapshot.states).get('msg_stable'), 'queued');
  const admission = lost.data.calls.find((call) => call.path.endsWith('/prompt'));
  assert.equal(admission.body.id, 'msg_stable');
  assert.equal(admission.body.delivery, 'queue');
  assert.equal(admission.body.files[0].uri, 'data:image/png;base64,AA==');
  assert.equal(lost.data.calls.filter((call) => call.path.endsWith('/prompt')).length, 1);

  const requests = fixture();
  let asked = 0;
  requests.client.on('permission', () => asked++);
  requests.data.permissions = [{ id: 'per_one', sessionID: 'ses_test', action: 'edit', resources: ['a'], source: { id: 'tool_one' } }];
  await requests.client.reconcile();
  await requests.client.reconcile();
  assert.equal(asked, 1);
  requests.api.getSession = async (id) => ({ id, ...(id === 'ses_child' ? { parentID: 'ses_test' } : {}), _activity: 'running' });
  requests.data.permissions.push({ id: 'per_child', sessionID: 'ses_child', action: 'read', resources: ['a'] },
    { id: 'per_other', sessionID: 'ses_unrelated', action: 'read', resources: ['b'] });
  let childRequest;
  requests.client.on('permission', (request) => { childRequest = request; });
  await requests.client.reconcile();
  assert.equal(asked, 2, 'only descendant requests reach the parent tab');
  await childRequest.respond('once');
  assert.ok(requests.data.calls.at(-1).path.includes('/ses_child/permission/per_child/reply'));
  const replies = requests.data.calls.filter((call) => call.method !== 'GET').length;
  requests.client.dispose();
  assert.equal(requests.data.calls.filter((call) => call.method !== 'GET').length, replies, 'closing a tab never denies server requests');
  assert.equal(toolUpdate({ id: 't', name: 'shell', state: { status: 'error', input: {},
    error: { message: 'Denied' }, content: [] } }).status, 'failed');

  // Shell permissions carry no metadata, so the arguments must come from the
  // tool call that raised the request; the card otherwise shows no command.
  const contextual = fixture();
  const shellPart = { id: 'tool_shell', type: 'tool', name: 'shell',
    state: { status: 'running', input: { command: 'rm -- old.txt', workdir: '/work' } } };
  contextual.data.history = [user('msg_user'), assistant([shellPart], false)];
  contextual.data.permissions = [{ id: 'per_shell', sessionID: 'ses_test', action: 'shell',
    resources: ['rm -- old.txt'], message: 'Run command',
    source: { type: 'tool', messageID: 'msg_answer', id: 'tool_shell' } }];
  let shellRequest;
  contextual.client.on('permission', (request) => { shellRequest = request; });
  await contextual.client.reconcile();
  assert.deepEqual(shellRequest.toolCall.rawInput, { command: 'rm -- old.txt', workdir: '/work' });

  // Parent tabs answer child-session permissions, but hold no child transcript.
  const childContext = fixture();
  childContext.api.getSession = async (id) => ({ id,
    ...(id === 'ses_child' ? { parentID: 'ses_test' } : {}), _activity: 'running' });
  childContext.data.messages = { msg_child: { id: 'msg_child', type: 'assistant', time: { created: 2 },
    content: [{ ...shellPart, id: 'tool_child' }] } };
  childContext.data.permissions = [{ id: 'per_child_shell', sessionID: 'ses_child', action: 'shell',
    resources: ['rm -- old.txt'], source: { type: 'tool', messageID: 'msg_child', id: 'tool_child' } }];
  let childShellRequest;
  childContext.client.on('permission', (request) => { childShellRequest = request; });
  await childContext.client.reconcile();
  assert.deepEqual(childShellRequest.toolCall.rawInput, { command: 'rm -- old.txt', workdir: '/work' },
    'missing child transcripts are read from the owning message');

  let response;
  const server = http.createServer((request, res) => {
    assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('opencode:test').toString('base64'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    response = res;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let connectionResolve;
  const connected = new Promise((resolve) => { connectionResolve = resolve; });
  let eventResolve;
  const received = new Promise((resolve) => { eventResolve = resolve; });
  const stream = new ServerEvents({ _resolveServer: async () => ({ url: `http://127.0.0.1:${server.address().port}`, password: 'test' }) }, {
    connected: connectionResolve, disconnected() {}, event: eventResolve,
  });
  stream.start();
  await connected;
  response.write(': heartbeat\r\ndata: {"type":"server.');
  response.write('connected",\r\ndata: "data":{}}\r\n\r\n');
  assert.equal((await received).type, 'server.connected', 'SSE frames survive split chunks and CRLF');
  stream.dispose();
  response.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log('SESSION CLIENT OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });

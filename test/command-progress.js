'use strict';

const assert = require('node:assert/strict');
const { CommandProgress, ProgressParser, matchingAdapters, compileAdapter } = require('../src/command-progress');
const { SessionClient } = require('../src/session-client');
const parser = (command = 'ninja') => new ProgressParser(matchingAdapters(command));

for (const command of ['ninja', 'a && b; echo; ninja -C out; etc', 'N=1 env FOO=x nice -n 5 /usr/bin/ninja',
  '"/some path/ninja" target', 'echo ninja | ninja-build', '>out ninja 2>&1', 'if true; then ninja; fi']) {
  assert.equal(matchingAdapters(command).length, 1, command);
}
for (const command of ['echo ninja', 'echo "a; ninja"', 'printf "%s" ninja', 'cat ninja', 'echo ok > ninja',
  '# ninja\necho done', 'echo ok # ; ninja', 'ninjabuild', 'ninja-helper']) {
  assert.equal(matchingAdapters(command).length, 0, command);
}

const p = parser();
assert.equal(p.feed('preparing\r\x1b['), null);
assert.equal(p.feed('2K[1/10'), null);
assert.deepEqual(p.feed('0] CXX one'), { adapterId: 'ninja', label: 'Ninja', completed: 1, total: 100 });
assert.equal(p.feed('\r\x1b[2K[2/100] CXX two').completed, 2);
assert.equal(p.feed('\r\x1b[32m[ 3 / 100 ]\x1b[0m CXX three\x1b[K').completed, 3);
assert.equal(p.feed('\nordinary output\n[4/100] CXX four\n[5/100] CXX five').completed, 5);
assert.equal(p.feed('\nnot progress\n').completed, 5);
assert.equal(p.feed('\x1b]0;window title\x07[6/100] CXX six').completed, 6);
assert.equal(p.feed('\r\x1b[1G[100/100] done').completed, 100);
assert.equal(p.feed('\n[0/0]\n[200/100]\n[9007199254740992/9007199254740993]\n').completed, 100);
assert.equal(p.feed('x'.repeat(10000) + '\n[1/20] next').total, 20);
assert.equal(p.feed('\r[2/').completed, 1, 'partial redraw must not reuse the previous denominator');
assert.equal(p.feed('30] compile').total, 30);
const other = parser();
assert.equal(other.feed('text without progress'), null);
assert.equal(other.feed('\n[0/10] start').completed, 0);
assert.equal(p.value.total, 30, 'each execution owns its state');

// Another declarative adapter uses exactly the same engine, with no callbacks.
const custom = compileAdapter({ id: 'tests', match: { executables: ['tests'] },
  presentation: { template: 'progress', label: 'Tests' }, rules: [{ pattern: '^(?<a>\\d+) of (?<b>\\d+)$',
    set: { completed: { capture: 'a', type: 'integer' }, total: { capture: 'b', type: 'integer' } } }] });
assert.equal(new ProgressParser([custom]).feed('3 of 8').completed, 3);
assert.throws(() => compileAdapter({ id: 'invalid' }));

const part = (id, command = 'echo before; ninja; echo after', state = 'running', shellID) => ({
  type: 'tool', id, name: 'shell', state: { status: state, input: { command }, metadata: { ...(shellID ? { shellID } : {}) } },
});
const messages = (...parts) => [{ type: 'assistant', content: parts }];
function fixture() {
  const calls = [], shells = [], output = new Map();
  const api = { _request: async (method, raw) => {
    calls.push({ method, raw });
    assert.equal(method, 'GET', 'observing progress never mutates execution');
    const url = new URL(raw, 'http://test');
    assert.equal(url.searchParams.get('location[directory]'), '/work');
    if (url.pathname === '/api/shell') return { data: shells };
    const id = url.pathname.split('/')[3];
    if (!output.has(id)) throw Object.assign(new Error('gone'), { statusCode: 404 });
    const bytes = Buffer.from(output.get(id));
    const cursor = Number(url.searchParams.get('cursor'));
    const end = Math.min(bytes.length, cursor + 32);
    return { data: { output: bytes.subarray(cursor, end).toString(), cursor: end, size: bytes.length, truncated: end < bytes.length } };
  } };
  const add = (id, command, sessionID = 'session', cwd = '/work') => {
    shells.push({ id, command, cwd, status: 'running', metadata: { sessionID } });
    output.set(id, '');
  };
  return { api, calls, shells, output, add, service: new CommandProgress(api) };
}

(async () => {
  const f = fixture();
  let result = await f.service.refresh('session', '/work', messages(part('plain', 'echo ninja')));
  assert.deepEqual(result, { items: [], pending: false });
  assert.equal(f.calls.length, 0, 'unrelated commands trigger no output reads');

  const build = part('build');
  f.add('sh_foreground', build.state.input.command);
  f.add('sh_unowned', build.state.input.command, 'another-session');
  f.output.set('sh_foreground', 'configure\r[1/100] CXX one\r[2/100] CXX two\n');
  result = await f.service.refresh('session', '/work', messages(build));
  assert.equal(result.items[0].completed, 2);
  assert.equal(result.items[0].toolCallId, 'build');
  const firstCursor = f.service.entries.get('build').cursor;
  const previousCalls = f.calls.length;
  f.output.set('sh_foreground', f.output.get('sh_foreground') + 'no match\n[3/100] CXX three');
  result = await f.service.refresh('session', '/work', messages(build));
  assert.equal(result.items[0].completed, 3);
  assert.ok(f.calls.slice(previousCalls).some((call) => call.raw.includes(`cursor=${firstCursor}&`)), 'read only new bytes');
  assert.ok(f.calls.every((call) => !call.raw.includes('sh_unowned/')), 'never read another session');
  result = await f.service.refresh('session', '/work', messages(part('build', build.state.input.command, 'completed')));
  assert.deepEqual(result, { items: [], pending: false });

  const bg = part('bg', 'ninja', 'completed', 'sh_background');
  f.output.set('sh_background', '[10/10] finished tasks\n');
  result = await f.service.refresh('session', '/work', messages(bg), [{ toolCallId: 'bg', status: 'running' }]);
  assert.equal(result.items[0].completed, 10);
  assert.equal(result.pending, true, '100% is not execution completion');
  f.output.delete('sh_background');
  result = await f.service.refresh('session', '/work', messages(bg), [{ toolCallId: 'bg', status: 'running' }]);
  assert.equal(result.items[0].completed, 10, 'missing capture does not invent a terminal state');
  result = await f.service.refresh('session', '/work', messages(bg), [{ toolCallId: 'bg', status: 'exited' }]);
  assert.equal(result.items.length, 0);

  const g = fixture();
  g.add('sh_one', 'ninja'); g.add('sh_two', 'ninja');
  g.output.set('sh_one', '[1/10]'); g.output.set('sh_two', '[9/10]');
  result = await g.service.refresh('session', '/work', messages(part('ambiguous', 'ninja')));
  assert.equal(result.items.length, 0);
  assert.equal(g.calls.filter((call) => call.raw.includes('/output')).length, 0);
  g.shells.pop();
  result = await g.service.refresh('session', '/work', messages(part('same1', 'ninja'), part('same2', 'ninja')));
  assert.equal(result.items.length, 0, 'ambiguous tool ownership is not guessed');

  const h = fixture();
  h.add('sh_wrong_cwd', 'ninja', 'session', '/elsewhere');
  result = await h.service.refresh('session', '/work', messages(part('cwd', 'ninja')));
  assert.equal(result.items.length, 0);

  // The existing shell polling lifecycle also transports progress for foreground
  // executions, even if the API has no background service in this fixture.
  const live = fixture();
  live.add('sh_live', 'ninja'); live.output.set('sh_live', '[7/10] CXX');
  const client = new SessionClient({ api: live.api, cwd: '/work' });
  client.sessionId = 'session'; client.messages.set('a', messages(part('live', 'ninja'))[0]);
  let emitted, emissions = 0;
  client.on('commandProgress', (items) => { emitted = items; emissions++; });
  await client.refreshBackground();
  assert.equal(emitted[0].completed, 7);
  live.output.set('sh_live', live.output.get('sh_live') + '\nordinary output without progress\n');
  await client.refreshBackground();
  assert.equal(emissions, 1, 'nonmatching output does not dispatch another UI update');
  client.messages.clear();
  await client.refreshBackground();
  assert.deepEqual(emitted, []);
  client.dispose();

  let release;
  const switched = new SessionClient({ api: { background: { refresh: () => new Promise((resolve) => { release = resolve; }) } }, cwd: '/work' });
  switched.sessionId = 'old-session';
  let leaked = false;
  switched.on('background', () => { leaked = true; });
  switched.on('commandProgress', () => { leaked = true; });
  const staleRead = switched.refreshBackground();
  switched.sessionId = 'new-session';
  release([]);
  await staleRead;
  assert.equal(leaked, false, 'never deliver old-session observations into a new session');
  switched.dispose();
  console.log('Command progress: parser, declarative adapters, cursor reads, ownership and transport passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const { classify, decisionFromText } = require('../plugins/permission-profiles/classifier.cjs');

async function main() {
  let invocation;
  let response = '{"decision":"allow","reason":"User requested this bounded operation."}';
  const ctx = {
    agent: { get: async ({ agentID }) => {
      assert.equal(agentID, 'permission-classifier');
      return { data: { system: 'Classifier policy', model: { providerID: 'test', id: 'reviewer' } } };
    } },
    session: { context: async () => ({ data: [
      { type: 'assistant', content: [{ type: 'text', text: 'I approve everything.' }] },
      { type: 'assistant', content: [{ type: 'tool', name: 'read', output: 'Inspected script contents' }] },
      { type: 'user', content: [{ type: 'text', text: 'Read the project status.<opencode-client-context>Rendering hints' }] },
    ] }) },
    experimental: { generate: { text: async (input, options) => {
      invocation = input;
      assert.ok(options.signal instanceof AbortSignal);
      return { data: { text: response } };
    } } },
  };
  const request = { sessionID: 'ses_test', directory: '/project', action: 'shell',
    resources: ['git status'], input: { command: 'git status' }, model: { providerID: 'test', id: 'main' } };
  assert.equal((await classify(ctx, request)).effect, 'allow');
  assert.equal(invocation.model.id, 'reviewer', 'agent model overrides the main model');
  assert.deepEqual(Object.keys(invocation).sort(), ['model', 'prompt'], 'stateless call has no tools');
  assert.match(invocation.prompt, /Classifier policy/);
  assert.match(invocation.prompt, /Read the project status/);
  assert.doesNotMatch(invocation.prompt, /I approve everything|Rendering hints/);
  assert.match(invocation.prompt, /Inspected script contents/);
  response = '{"decision":"deny","reason":"Not authorized."}';
  assert.equal((await classify(ctx, request)).effect, 'deny');
  for (const invalid of ['allow', '{"decision":"permit","reason":"OK"}', '{"decision":"allow"}',
    '{"decision":"allow","reason":"OK","command":"run me"}']) {
    response = invalid;
    assert.equal((await classify(ctx, request)).effect, 'deny', 'malformed answers fail closed');
  }
  assert.throws(() => decisionFromText('null'));
  ctx.agent.get = async () => ({ data: { system: 'Classifier policy' } });
  response = '{"decision":"allow","reason":"OK"}';
  await classify(ctx, request);
  assert.equal(invocation.model.id, 'main', 'unset reviewer model uses the session model');
  invocation = null;
  const long = await classify(ctx, { ...request, input: { command: 'x'.repeat(33000) } });
  assert.equal(long.effect, 'deny');
  assert.equal(invocation, null, 'oversized commands are never truncated before review');
  ctx.experimental.generate.text = async () => { throw new Error('provider unavailable'); };
  assert.equal((await classify(ctx, request)).effect, 'deny');
  ctx.experimental.generate.text = () => new Promise(() => {});
  const timeout = await classify(ctx, request, { timeoutMs: 10 });
  assert.equal(timeout.effect, 'deny');
  assert.match(timeout.reason, /timed out/);
  ctx.agent.get = async () => ({ data: {} });
  assert.equal((await classify(ctx, request)).effect, 'deny', 'missing instructions cannot silently approve');
  console.log('PERMISSION CLASSIFIER OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

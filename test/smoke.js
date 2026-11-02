'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeApi } = require('../src/api');
const { AcpClient } = require('../src/acp');

const cwd = process.env.OPENCODE_TEST_CWD || path.join(os.tmpdir(), 'opencode-acp-test');
fs.mkdirSync(cwd, { recursive: true });
const command = process.env.OPENCODE_COMMAND || 'opencode';
const log = (message) => console.log('[log]', message);

async function collectPrompt(client, text) {
  const updates = [];
  const onUpdate = (params) => updates.push(params.update);
  client.on('update', onUpdate);
  const result = await client.prompt(text);
  await new Promise((resolve) => setTimeout(resolve, 300));
  client.removeListener('update', onUpdate);
  return { result, updates };
}

(async () => {
  const api = new OpenCodeApi({ command, log });

  const before = await api.listSessions(cwd);
  console.log('sessions before:', before.length);

  const created = new AcpClient({ command, cwd, log });
  await created.start();
  const session = await created.newSession();
  console.log('created session:', session.sessionId);
  assert.ok(session.sessionId);

  const prompt = await collectPrompt(created, 'Reply with exactly: SMOKE-OK');
  const assistantText = prompt.updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content && update.content.text)
    .join('');
  console.log('assistant text:', JSON.stringify(assistantText));
  assert.ok(assistantText.includes('SMOKE-OK'), 'assistant did not answer');
  assert.strictEqual(prompt.result.stopReason, 'end_turn');

  created.dispose();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const listed = await api.listSessions(cwd);
  assert.ok(
    listed.some((item) => item.id === session.sessionId),
    'created session is missing from the REST list'
  );

  const loaded = new AcpClient({ command, cwd, log });
  const replayed = [];
  loaded.on('update', (params) => replayed.push(params.update));
  await loaded.start();
  await loaded.loadSession(session.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const replayText = replayed
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content && update.content.text)
    .join('');
  console.log('replayed agent text:', JSON.stringify(replayText));
  assert.ok(replayText.includes('SMOKE-OK'), 'session/load did not replay history');
  loaded.dispose();

  await api.deleteSession(session.sessionId);
  const after = await api.listSessions(cwd);
  assert.ok(!after.some((item) => item.id === session.sessionId), 'session was not deleted');
  console.log('SMOKE OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

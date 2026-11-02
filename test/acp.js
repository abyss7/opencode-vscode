'use strict';

const assert = require('node:assert');
const { AcpClient } = require('../src/acp');

function fakeClient() {
  const client = new AcpClient({ command: 'opencode', cwd: '/work', log: () => {} });
  client.child = {
    stdin: {
      writable: true,
      write() {},
    },
  };
  return client;
}

async function run() {
  // `_request` resolves with the result and clears the pending entry.
  {
    const client = fakeClient();
    const promise = client._request('initialize', { a: 1 });
    client._onStdout(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`);
    assert.deepStrictEqual(await promise, { ok: true });
    assert.strictEqual(client._pending.size, 0);
  }

  // Error responses reject, and code -32000 appends the auth hint.
  {
    const client = fakeClient();
    const promise = client._request('session/load', {});
    client._onStdout(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Unauthorized' } })}\n`
    );
    await assert.rejects(promise, /opencode auth login/);
  }

  // A request times out and drops its pending entry.
  {
    const client = fakeClient();
    await assert.rejects(client._request('initialize', {}, 5), /timed out/);
    assert.strictEqual(client._pending.size, 0);
  }

  // Chunks split mid-line are buffered until a newline arrives.
  {
    const client = fakeClient();
    const promise = client._request('initialize', {});
    client._onStdout('{"jsonrpc":"2.0","id":1,"result":');
    client._onStdout('{"x":1}}\n');
    assert.deepStrictEqual(await promise, { x: 1 });
  }

  // Permission requests auto-cancel when no listener is attached.
  {
    const client = fakeClient();
    let sent = null;
    client.child.stdin.write = (data) => {
      sent = data;
    };
    client._handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { sessionId: 's', options: [] },
      })
    );
    const parsed = JSON.parse(sent);
    assert.strictEqual(parsed.id, 7);
    assert.deepStrictEqual(parsed.result.outcome, { outcome: 'cancelled' });
  }

  // Permission requests with a listener are emitted and can be answered.
  {
    const client = fakeClient();
    let received = null;
    client.on('permission', (request) => {
      received = request;
    });
    client._handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'session/request_permission',
        params: { sessionId: 's', options: [{ optionId: 'allow', name: 'Allow' }] },
      })
    );
    assert.ok(received);
    assert.strictEqual(received.requestId, 8);
    received.respond('allow');
  }

  // Elicitation requests cancel when the mode is not a form.
  {
    const client = fakeClient();
    let sent = null;
    client.child.stdin.write = (data) => {
      sent = data;
    };
    client._handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: { mode: 'text' } })
    );
    assert.deepStrictEqual(JSON.parse(sent).result, { action: 'cancel' });
  }

  console.log('ACP OK');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AcpClient } = require('../src/acp');
const { SessionClient } = require('../src/session-client');
const { OpenCodeApi } = require('../src/api');

const cwd = process.env.OPENCODE_TEST_CWD || path.join(os.tmpdir(), 'opencode-acp-test');
fs.mkdirSync(cwd, { recursive: true });
const log = (message) => console.log('[log]', message);

(async () => {
  const client = new AcpClient({ command: 'opencode', cwd, log });
  const api = new OpenCodeApi({ command: 'opencode', log });
  const shared = new SessionClient({ api, cwd, log });
  const ids = [];
  const option = (source, id) => source.configOptions.find((item) => item.id === id);
  const compare = () => {
    for (const id of ['model', 'effort']) {
      assert.equal(option(shared, id)?.currentValue, option(client, id)?.currentValue, `${id} matches ACP`);
    }
    assert.deepEqual(option(shared, 'effort')?.options.map((item) => item.value),
      option(client, 'effort')?.options.map((item) => item.value), 'effort catalog matches ACP');
  };
  const select = async (id, value) => {
    await client.setConfigOption(id, value);
    await shared.setConfigOption(id, value);
    compare();
    const model = (await api.getSession(shared.sessionId)).model;
    assert.equal(`${model.providerID}/${model.id}`, option(shared, 'model').currentValue);
    assert.equal(model.variant || 'default', option(shared, 'effort').currentValue);
  };
  try {
    await client.start();
    ids.push((await client.newSession()).sessionId);
    const created = await api._request('POST', '/api/session', {
      id: `ses_${randomUUID().replaceAll('-', '')}`, location: { directory: cwd },
    });
    shared.sessionId = created.data.id;
    ids.push(shared.sessionId);
    await shared.refreshConfig();
    compare();
    assert.ok(option(shared, 'model').currentValue, 'default model is resolved on a new shared session');
    const effort = option(shared, 'effort')?.options.find((item) => item.value !== 'default');
    if (effort) {
      await select('effort', effort.value);
      await select('model', option(shared, 'model').currentValue);
      await select('effort', 'default');
      await select('effort', effort.value);
    }
    const model = option(shared, 'model');
    const target = model.options.find((item) => item.value !== model.currentValue) || model.options[0];
    assert.ok(target, 'the model list is not empty');
    await select('model', target.value);
    const reopened = new SessionClient({ api, cwd, log });
    reopened.sessionId = shared.sessionId;
    await reopened.refreshConfig();
    assert.deepEqual(reopened.configOptions, shared.configOptions, 'shared selection survives reopening');
    console.log('CONFIG OK: shared-server Model/Effort parity with ACP, persistence and reopening');
  } finally {
    shared.dispose();
    client.dispose();
    for (const id of ids) await api.deleteSession(id);
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AcpClient } = require('../src/acp');
const { OpenCodeApi } = require('../src/api');

const cwd = process.env.OPENCODE_TEST_CWD || path.join(os.tmpdir(), 'opencode-acp-test');
fs.mkdirSync(cwd, { recursive: true });
const log = (message) => console.log('[log]', message);

(async () => {
  const client = new AcpClient({ command: 'opencode', cwd, log });
  await client.start();
  const created = await client.newSession();
  console.log('session', created.sessionId);
  console.log('config before', JSON.stringify(client.configOptions.map((o) => [o.id, o.currentValue])));
  const model = client.configOptions.find((option) => option.category === 'model');
  const target =
  model.options.find((option) => option.value !== model.currentValue) || model.options[0];
if (!target) throw new Error('the model list is empty');
  const options = await client.setConfigOption(model.id, target.value);
  console.log('config after', JSON.stringify(options.map((o) => [o.id, o.currentValue])));
  const updated = options.find((option) => option.id === model.id);
  if (updated.currentValue !== target.value) throw new Error('model was not changed');
  const api = new OpenCodeApi({ command: 'opencode', log });
  await api.deleteSession(created.sessionId);
  client.dispose();
  console.log('CONFIG OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

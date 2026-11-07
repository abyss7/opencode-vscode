'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return { Uri: { joinPath: (...parts) => parts.join('/') } };
  return originalLoad.apply(this, arguments);
};
const { SessionPanel } = require('../src/session-panel');
Module._load = originalLoad;

function createPanel() {
  const panel = Object.create(SessionPanel.prototype);
  Object.assign(panel, {
    panel: { active: false },
    deps: { extensionUri: '/extension', getConfig: () => ({}) },
    _permissions: new Map(), _elicitations: new Map(),
    _post: () => {}, _refreshSubagents: () => {}, _focusIfActive: () => {},
  });
  panel._setIcon('idle');
  return panel;
}

(async () => {
  const panel = createPanel();
  panel._loading = true;
  panel._refreshAttention();
  assert.match(panel.panel.iconPath, /opencode-loading.svg$/, 'an unresolved tab has a loading icon');
  panel._loading = false;
  panel.setArchived(true);
  assert.match(panel.panel.iconPath, /opencode-archived.svg$/, 'an archived tab has a distinct icon');
  panel.setArchiveFinalizing(true);
  assert.match(panel.panel.iconPath, /opencode-working.svg$/, 'archive finalization is visibly active');
  panel.setArchiveFinalizing(false);
  assert.match(panel.panel.iconPath, /opencode-archived.svg$/, 'completed finalization returns to the archive icon');
  panel.setArchived(false);
  panel._startTurn();
  let answered = 0;
  const permission = {
    requestId: 'permission', options: [{ optionId: 'allow', kind: 'allow_once' }],
    respond: () => answered++,
  };
  await panel._onPermission(permission);
  assert.match(panel.panel.iconPath, /opencode-attention.svg$/);
  panel._onElicitation({ requestId: 'question', respond: () => answered++ });
  panel.panel.active = true;
  panel._onViewState();
  assert.match(panel.panel.iconPath, /opencode-attention.svg$/, 'viewing is not answering');
  panel._answerPermission('permission', 'invalid');
  assert.equal(answered, 0);
  panel._answerPermission('permission', 'allow');
  assert.match(panel.panel.iconPath, /opencode-attention.svg$/, 'question still pending');
  panel._answerElicitation('question', 'accept', {});
  assert.equal(answered, 2);
  assert.match(panel.panel.iconPath, /opencode-working.svg$/);

  panel._onElicitation({ requestId: 'question', respond: () => {} });
  panel.panel.active = false;
  panel._finishTurn('ready');
  assert.match(panel.panel.iconPath, /opencode-attention.svg$/);
  panel._answerElicitation('question', 'cancel');
  assert.match(panel.panel.iconPath, /opencode-done.svg$/);

  panel._onElicitation({ requestId: 'question', respond: () => {} });
  panel.panel.active = true;
  panel._onViewState();
  panel._answerElicitation('question', 'cancel');
  assert.match(panel.panel.iconPath.light, /opencode-light.svg$/);

  panel._startTurn();
  panel._client = { cancel: () => {} };
  panel._onElicitation({ requestId: 'question', respond: () => {} });
  panel._cancel();
  assert.match(panel.panel.iconPath, /opencode-working.svg$/);
  await panel._onPermission(permission);
  panel._onExit({ code: 1 });
  assert.match(panel.panel.iconPath.light, /opencode-light.svg$/);

  panel.deps.getConfig = () => ({ autoApprovePermissions: 'allowAll' });
  await panel._onPermission(permission);
  assert.match(panel.panel.iconPath.light, /opencode-light.svg$/, 'auto-approval needs no attention');
  console.log('Attention tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

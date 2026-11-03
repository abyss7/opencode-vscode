'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const cwd = process.env.OPENCODE_TEST_CWD || path.join(os.tmpdir(), 'opencode-acp-test');
fs.mkdirSync(cwd, { recursive: true });

const vscode = {
  Uri: {
    joinPath: (base, ...parts) => [base, ...parts].join('/'),
    parse: (value) => value,
  },
  ViewColumn: { Active: 1 },
  env: { openExternal: async () => true },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const { AcpClient } = require('../src/acp');
const { SessionPanel } = require('../src/session-panel');

const PARENT = 'ses_parent';
const CHILD = 'ses_child';

function fakeWebview() {
  const messages = [];
  return {
    messages,
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri) => uri,
    postMessage: async (message) => {
      messages.push(message);
      return true;
    },
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    html: '',
  };
}

function fakePanel() {
  const webview = fakeWebview();
  return {
    webview,
    panel: {
      title: '',
      iconPath: null,
      active: false,
      webview,
      onDidDispose: () => ({ dispose: () => {} }),
      onDidChangeViewState: () => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    },
  };
}

function createSessionPanel() {
  const { panel, webview } = fakePanel();
  const deps = {
    extensionUri: path.resolve(__dirname, '..'),
    api: {},
    log: () => {},
    getConfig: () => ({ command: 'opencode' }),
    onSessionCreated: () => {},
    onSessionDisposed: () => {},
    onSessionChanged: () => {},
  };
  const sessionPanel = new SessionPanel({
    panel,
    sessionId: PARENT,
    cwd,
    deps,
  });
  return { sessionPanel, messages: webview.messages };
}

function stripPosts(messages) {
  return messages.filter((message) => message.type === 'subagents');
}

function childUpdate(update, extra = {}) {
  return {
    type: 'update',
    rootSessionId: PARENT,
    childSessionId: CHILD,
    parentSessionId: PARENT,
    title: 'map the strip',
    update,
    ...extra,
  };
}

(async () => {
  // The client asks the agent for out-of-band child-session updates; without
  // this the agent folds them into the parent transcript.
  {
    const client = new AcpClient({ command: 'opencode', cwd, log: () => {} });
    const params = client.initializeParams();
    assert.strictEqual(
      params._meta['opencode/child-session-updates'],
      true,
      'initialize must advertise child-session updates'
    );
    assert.strictEqual(params.protocolVersion, 1);
  }

  // A child update is routed to its own event and never reaches the transcript.
  {
    const client = new AcpClient({ command: 'opencode', cwd, log: () => {} });
    const seen = { child: 0, plain: 0 };
    client.on('childUpdate', () => {
      seen.child += 1;
    });
    client.on('update', () => {
      seen.plain += 1;
    });
    const params = childUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: `${CHILD}:tool-1`,
      kind: 'search',
      title: 'map the strip: Grep "subagent"',
      status: 'in_progress',
    });
    client._handleNotification({
      jsonrpc: '2.0',
      method: 'opencode/session/child_update',
      params,
    });
    assert.strictEqual(seen.child, 1, 'child update must be emitted separately');
    assert.strictEqual(seen.plain, 0, 'child update must not reach the parent');
  }

  // A child tool call shows up in the strip and never in the transcript.
  {
    const { sessionPanel, messages } = createSessionPanel();
    sessionPanel._onChildUpdate(
      childUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: `${CHILD}:tool-1`,
        kind: 'grep',
        status: 'in_progress',
      })
    );
    const posts = stripPosts(messages);
    assert.strictEqual(posts.length, 1, 'one strip post expected');
    const [item] = posts[0].items;
    assert.strictEqual(item.id, CHILD);
    assert.strictEqual(item.title, 'map the strip');
    assert.strictEqual(item.action, 'search');
    assert.strictEqual(item.running, true);
    assert.strictEqual(
      messages.some((message) => message.type === 'update'),
      false,
      'the transcript must stay untouched'
    );
    sessionPanel.dispose();
  }

  // A renamed child republishes the strip even when nothing else changed.
  {
    const { sessionPanel, messages } = createSessionPanel();
    sessionPanel._onChildUpdate(
      childUpdate({ sessionUpdate: 'agent_message_chunk' })
    );
    sessionPanel._onChildUpdate(
      childUpdate({ sessionUpdate: 'agent_message_chunk' }, { title: 'renamed' })
    );
    const posts = stripPosts(messages);
    assert.strictEqual(posts.length, 2, 'a title change alone must republish');
    assert.strictEqual(posts[1].items[0].title, 'renamed');
    sessionPanel.dispose();
  }

  // Grandchildren and other roots never reach the strip.
  {
    const { sessionPanel, messages } = createSessionPanel();
    sessionPanel._onChildUpdate(
      childUpdate({ sessionUpdate: 'tool_call', kind: 'read' }, {
        rootSessionId: 'ses_other',
        parentSessionId: 'ses_grand',
      })
    );
    assert.strictEqual(stripPosts(messages).length, 0);
    sessionPanel.dispose();
  }

  // Polled tokens survive a live update that only knows the current action.
  {
    const { sessionPanel, messages } = createSessionPanel();
    sessionPanel._subagentsPolled = new Map([
      [
        CHILD,
        {
          id: CHILD,
          title: 'from rest',
          running: false,
          action: 'read',
          tokens: 1234,
        },
      ],
    ]);
    sessionPanel._onChildUpdate(
      childUpdate(
        { sessionUpdate: 'tool_call', kind: 'edit', status: 'in_progress' },
        { title: '' }
      )
    );
    const [item] = stripPosts(messages)[0].items;
    assert.strictEqual(item.title, 'from rest', 'the REST title wins when live has none');
    assert.strictEqual(item.action, 'edit', 'live action wins over the polled one');
    assert.strictEqual(item.tokens, 1234, 'polled token estimate is kept');
    sessionPanel.dispose();
  }

  // A reloaded webview gets the strip again even when nothing changed.
  {
    const { sessionPanel, messages } = createSessionPanel();
    sessionPanel._onChildUpdate(
      childUpdate({ sessionUpdate: 'agent_message_chunk' })
    );
    const before = stripPosts(messages).length;
    sessionPanel._resendSubagents();
    assert.strictEqual(
      stripPosts(messages).length,
      before + 1,
      'a fresh webview must receive the current strip'
    );
    sessionPanel.dispose();
  }

  {
    const { sessionPanel } = createSessionPanel();
    sessionPanel.deps.api.listMessages = async () => [
      { type: 'assistant', content: [{ type: 'text', text: 'Final result.\nAll checks passed.' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Earlier progress' }] },
    ];
    const stats = await sessionPanel._subagentStats(CHILD);
    assert.strictEqual(stats.result, 'Final result. All checks passed.');
    sessionPanel.dispose();
  }

  console.log('CHILD UPDATES OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OpenCodeSync,
  decideSync,
  isCompatible,
  normalizeValue,
  readSettingFromObject,
} = require('../src/opencode-sync');
const { parse } = require('../src/jsonc');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sync-'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  return parse(fs.readFileSync(file, 'utf8'));
}

function createFakeVscode(options = {}) {
  const stores = {
    global: new Map(),
    workspace: new Map(),
    folders: new Map(),
  };
  const disposables = [];

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    env: { remoteName: options.remoteName },
    RelativePattern: class RelativePattern {
      constructor(basePath, pattern) {
        this.base = basePath;
        this.pattern = pattern;
      }
    },
    workspace: {
      workspaceFolders: options.workspaceFolders || [],
      textDocuments: [],
      getConfiguration(section, scopeUri) {
        // VS Code prepends the selected section to every inspect/update key.
        const qualify = (id) => section ? `${section}.${id}` : id;
        const folderValues = () =>
          scopeUri && scopeUri.fsPath
            ? stores.folders.get(scopeUri.fsPath) || new Map()
            : null;
        return {
          inspect(id) {
            id = qualify(id);
            const folders = folderValues();
            return {
              key: id,
              defaultValue: undefined,
              globalValue: stores.global.get(id),
              workspaceValue: stores.workspace.get(id),
              workspaceFolderValue: folders ? folders.get(id) : undefined,
            };
          },
          async update(id, value, target) {
            id = qualify(id);
            let targetMap;
            if (target === 1) targetMap = stores.global;
            else if (target === 2) targetMap = stores.workspace;
            else {
              if (!scopeUri || !scopeUri.fsPath) throw new Error('folder target without scope');
              if (!stores.folders.has(scopeUri.fsPath)) {
                stores.folders.set(scopeUri.fsPath, new Map());
              }
              targetMap = stores.folders.get(scopeUri.fsPath);
            }
            if (value === undefined) targetMap.delete(id);
            else targetMap.set(id, value);
          },
        };
      },
      onDidChangeConfiguration(listener) {
        disposables.push({ dispose() {} });
        return disposables[disposables.length - 1];
      },
      onDidChangeWorkspaceFolders(listener) {
        disposables.push({ dispose() {} });
        return disposables[disposables.length - 1];
      },
      onDidSaveTextDocument(listener) {
        disposables.push({ dispose() {} });
        return disposables[disposables.length - 1];
      },
      createFileSystemWatcher() {
        return {
          onDidChange() {},
          onDidCreate() {},
          onDidDelete() {},
          dispose() {},
        };
      },
    },
  };

  return { vscode, stores };
}

function resetEnv() {
  delete process.env.OPENCODE_DISABLE_SETTINGS_SYNC;
  delete process.env.VSCODE_AGENT_FOLDER;
}

async function run() {
  // Pure decisions.
  assert.deepStrictEqual(decideSync({ open: 'a', vs: undefined }), {
    nextOpen: 'a',
    nextVs: 'a',
  });
  assert.deepStrictEqual(decideSync({ open: undefined, vs: 'b' }), {
    nextOpen: 'b',
    nextVs: 'b',
  });
  assert.deepStrictEqual(decideSync({ open: 'a', vs: 'b' }), {
    nextOpen: 'a',
    nextVs: 'a',
  });
  assert.deepStrictEqual(
    decideSync({ open: 'c', vs: 'b', previous: { open: 'a', vs: 'b' } }),
    { nextOpen: 'c', nextVs: 'c' }
  );
  assert.deepStrictEqual(
    decideSync({ open: 'a', vs: 'c', previous: { open: 'a', vs: 'b' } }),
    { nextOpen: 'c', nextVs: 'c' }
  );
  assert.deepStrictEqual(
    decideSync({ open: 'c', vs: 'd', previous: { open: 'a', vs: 'b' } }),
    { nextOpen: 'c', nextVs: 'c' }
  );
  assert.deepStrictEqual(
    decideSync({ open: undefined, vs: 'b', previous: { open: 'a', vs: 'b' } }),
    { nextOpen: undefined, nextVs: undefined }
  );

  const model = {
    types: ['string'],
    kind: 'scalar',
    format: 'model-ref',
    pattern: '^[^/#]+\\/[^#]+(?:#[^#]+)?$',
  };
  const update = { types: ['string'], kind: 'scalar', enum: ['disable', 'notify', 'auto'] };
  const permissions = { types: ['array'], kind: 'complex' };
  const skills = { types: ['array'], kind: 'array', itemType: 'string' };
  const depth = { types: ['integer'], kind: 'scalar', minimum: 0 };
  assert.strictEqual(isCompatible(model, 'openai/gpt-5'), true);
  assert.strictEqual(isCompatible(model, 'not-a-model'), false);
  // The sync normalizes the structured form before it gets here.
  assert.strictEqual(isCompatible(model, { providerID: 'openai', model: 'gpt-5' }), false);
  assert.strictEqual(
    normalizeValue(model, { providerID: 'openai', model: 'gpt-5', variant: 'high' }),
    'openai/gpt-5#high'
  );
  assert.strictEqual(
    normalizeValue(model, { providerID: 'acme', model: 'chat-large' }),
    'acme/chat-large'
  );
  assert.strictEqual(normalizeValue(model, 'openai/gpt-5'), 'openai/gpt-5');
  assert.strictEqual(normalizeValue(model, undefined), undefined);
  assert.deepStrictEqual(
    normalizeValue(model, { model: 'gpt-5' }),
    { model: 'gpt-5' },
    'an unrepresentable object is left alone for the incompatible-value path'
  );
  assert.deepStrictEqual(normalizeValue({ types: ['string'] }, { a: 1 }), { a: 1 });
  assert.strictEqual(isCompatible(depth, 2), true);
  assert.strictEqual(isCompatible(depth, 2.5), false);
  assert.strictEqual(isCompatible(depth, -1), false);
  assert.strictEqual(isCompatible(depth, '2'), false);
  assert.strictEqual(isCompatible(update, 'notify'), true);
  assert.strictEqual(isCompatible(update, 'sometimes'), false);
  assert.strictEqual(isCompatible(permissions, [{ action: 'shell' }]), true);
  assert.strictEqual(isCompatible(permissions, 'nope'), false);
  assert.strictEqual(isCompatible(skills, ['a', 'b']), true);
  assert.strictEqual(isCompatible(skills, ['a', 1]), false);

  assert.strictEqual(
    readSettingFromObject({ opencode: { model: 'a/b' } }, { id: 'opencode.model', path: ['model'] }),
    'a/b'
  );
  assert.strictEqual(
    readSettingFromObject({ 'opencode.model': 'c/d' }, { id: 'opencode.model', path: ['model'] }),
    'c/d'
  );
  assert.strictEqual(
    readSettingFromObject(
      { opencode: { model: 'nested/x' }, 'opencode.model': 'flat/y' },
      { id: 'opencode.model', path: ['model'] }
    ),
    'flat/y',
    'flat dotted keys take precedence over the legacy nested form'
  );

  // Global scope through the VS Code configuration API.
  resetEnv();
  const globalDir = path.join(base, 'global');
  const projectDir = path.join(base, 'project');
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.OPENCODE_CONFIG_DIR = globalDir;

  const globalFile = path.join(globalDir, 'opencode.jsonc');
  writeJson(globalFile, { model: 'openai/gpt-5', default_agent: 'build' });
  writeJson(path.join(projectDir, 'opencode.jsonc'), {
    shell: '/bin/zsh',
    compaction: { auto: false },
  });

  const folder = { name: 'project', uri: { fsPath: projectDir, toString: () => projectDir } };
  const { vscode, stores } = createFakeVscode({ workspaceFolders: [folder] });
  stores.global.set('opencode.model', 'anthropic/claude-sonnet-5-5');
  stores.global.set('opencode.default_agent', 'plan');
  stores.workspace.set('opencode.shell', '/bin/bash');
  stores.workspace.set('opencode.compaction.auto', true);
  stores.workspace.set('opencode.model', 'acme/workspace-chat#medium');

  const sync = new OpenCodeSync({ vscode, command: '/nonexistent/opencode', log: () => {} });
  await sync.start();

  assert.strictEqual(stores.global.get('opencode.model'), 'openai/gpt-5');
  assert.strictEqual(stores.global.get('opencode.default_agent'), 'build');
  assert.strictEqual(readJson(globalFile).model, 'openai/gpt-5');
  assert.strictEqual(readJson(path.join(projectDir, 'opencode.jsonc')).model,
    'acme/workspace-chat#medium', 'Workspace default must reach OpenCode without changing the global model');
  assert.strictEqual(stores.workspace.get('opencode.model'), 'acme/workspace-chat#medium');
  assert.strictEqual(stores.workspace.get('opencode.shell'), '/bin/zsh');
  assert.strictEqual(stores.workspace.get('opencode.compaction.auto'), false);
  assert.strictEqual(
    readJson(path.join(projectDir, 'opencode.jsonc')).compaction.auto,
    false
  );

  stores.global.set('opencode.model', 'google/gemini');
  await sync._enqueue();
  assert.strictEqual(readJson(globalFile).model, 'google/gemini');

  // A structured VS Code value is stored compactly: the setting and its
  // dropdown only hold `provider/model#variant`.
  stores.global.set('opencode.model', {
    providerID: 'acme',
    model: 'chat-large',
    variant: 'high',
  });
  await sync._enqueue();
  assert.strictEqual(readJson(globalFile).model, 'acme/chat-large#high');

  writeJson(globalFile, {
    ...readJson(globalFile),
    model: 'openai/o3',
  });
  await sync._enqueue();
  assert.strictEqual(stores.global.get('opencode.model'), 'openai/o3');

  // A structured value in opencode.json(c) is mirrored to VS Code as a string.
  writeJson(globalFile, {
    ...readJson(globalFile),
    model: { providerID: 'acme', model: 'chat-large' },
  });
  await sync._enqueue();
  assert.strictEqual(stores.global.get('opencode.model'), 'acme/chat-large');

  const withoutAgent = readJson(globalFile);
  delete withoutAgent.default_agent;
  writeJson(globalFile, withoutAgent);
  await sync._enqueue();
  assert.strictEqual(stores.global.get('opencode.default_agent'), undefined);

  stores.global.set('opencode.default_agent', 'plan');
  await sync._enqueue();
  assert.strictEqual(readJson(globalFile).default_agent, 'plan');

  stores.workspace.set('opencode.compaction.auto', true);
  await sync._enqueue();
  assert.strictEqual(readJson(path.join(projectDir, 'opencode.jsonc')).compaction.auto, true);

  stores.workspace.set('opencode.model', 'acme/workspace-chat#high');
  await sync._enqueue();
  assert.strictEqual(readJson(path.join(projectDir, 'opencode.jsonc')).model, 'acme/workspace-chat#high');

  const projectFile = path.join(projectDir, 'opencode.jsonc');
  writeJson(projectFile, { ...readJson(projectFile), model: 'acme/project-chat#low' });
  await sync._enqueue();
  assert.strictEqual(stores.workspace.get('opencode.model'), 'acme/project-chat#low',
    'OpenCode changes must update the actual Workspace key, not opencode.opencode.model');
  assert.strictEqual(stores.workspace.has('opencode.opencode.model'), false);

  stores.workspace.delete('opencode.model');
  await sync._enqueue();
  assert.strictEqual(readJson(projectFile).model, undefined, 'removing the Workspace override restores inheritance');

  sync.dispose();

  // Remote window: global OpenCode settings map to the machine settings file.
  delete process.env.OPENCODE_CONFIG_DIR;
  const agentFolder = path.join(base, 'agent');
  const machineDir = path.join(agentFolder, 'data', 'Machine');
  fs.mkdirSync(machineDir, { recursive: true });
  const machineFile = path.join(machineDir, 'settings.json');
  writeJson(machineFile, {
    'peacock.surpriseMeOnStartup': true,
    'opencode.model': 'local/machine-model',
  });
  process.env.VSCODE_AGENT_FOLDER = agentFolder;
  process.env.OPENCODE_CONFIG_DIR = globalDir;
  writeJson(globalFile, { model: 'openai/gpt-5' });

  const remote = createFakeVscode({
    workspaceFolders: [],
    remoteName: 'ssh-remote',
  });
  const remoteSync = new OpenCodeSync({
    vscode: remote.vscode,
    command: '/nonexistent/opencode',
    log: () => {},
  });
  await remoteSync.start();

  const machine = readJson(machineFile);
  assert.strictEqual(machine['peacock.surpriseMeOnStartup'], true);
  assert.strictEqual(machine['opencode.model'], 'openai/gpt-5');

  machine['opencode.model'] = 'anthropic/claude-sonnet-5-5';
  writeJson(machineFile, machine);
  await remoteSync._enqueue();
  assert.strictEqual(readJson(globalFile).model, 'anthropic/claude-sonnet-5-5');

  remoteSync.dispose();
  resetEnv();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('SYNC OK');
}

run().catch((error) => {
  resetEnv();
  fs.rmSync(base, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});

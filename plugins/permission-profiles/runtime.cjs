'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const engine = require('./engine.cjs');
const project = require('./project.cjs');
const globalPermissions = require('./global.cjs');
const { createManager, resolveBase } = require('./session-temp.cjs');
const { createBridge, result: rpcResult, failure } = require('./bridge.cjs');
const { classify, CLASSIFIER } = require('./classifier.cjs');
const { randomUUID, createHash } = require('node:crypto');

async function setup(ctx, contract, directory, configDirectory = path.resolve(__dirname, '../..')) {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const inputs = new Map();
  const reviews = [];
  const temporary = createManager();
  const callKey = (event) => `${event.sessionID}/${event.messageID}/${event.id}`;
  const file = (id) => {
    if (!/^ses_[\w-]+$/.test(id)) throw new Error('Invalid session ID');
    return path.join(root, `${id}.json`);
  };
  const read = (id) => {
    try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const write = (id, state) => {
    const target = file(id);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, target);
  };
  const session = async (id) => {
    const result = await ctx.session.get({ sessionID: id });
    const info = result?.data || result;
    if (!info?.id) throw new Error('Session not found');
    return info;
  };
  const ancestors = async (id) => {
    const states = [];
    const descendants = [];
    const seen = new Set();
    while (id) {
      if (seen.has(id) || seen.size >= 64) throw new Error('Invalid session ancestry');
      seen.add(id);
      const state = read(id);
      if (state) {
        state.sessionID = id;
        // Read on each operation so other sessions and offline edits take effect.
        state.projectRules = project.read(state.cwd);
        const profiles = engine.compileLayers(state.layers);
        for (const child of descendants) {
          const selected = state.agentProfiles?.[child.agent];
          if (!selected) continue;
          const childState = engine.selectProfile({ choices: {} }, profiles, selected);
          states.push({ ...state, ...childState, agent: child.agent });
        }
        states.push(state);
      }
      const info = await session(id);
      descendants.push(info);
      id = info.parentID;
    }
    return states;
  };
  const disposeTemporary = await temporary.register(ctx, async (id) => (await ancestors(id))[0]);
  const view = (state, inherited = false) => {
    const profiles = engine.compileLayers(state.layers);
    const profile = profiles[state.selected];
    if (!profile) throw new Error('Selected profile is missing');
    return {
      version: engine.VERSION, selected: state.selected,
      newActions: state.choices[state.selected], inherited,
      agent: state.agent,
      profiles: Object.values(profiles).map(({ id, label }) => ({ id, label })),
      layers: profile.layers.map(({ name }) => name),
      fallbackLocked: ['all', 'host', 'read-only'].includes(state.selected),
      rulesFile: project.filename(state.cwd),
      allowSessionTemp: state.allowSessionTemp !== false,
      sessionTempBaseDirectory: state.sessionTempBaseDirectory || resolveBase(),
    };
  };
  const decisionFor = (states, request) => {
    if (!Array.isArray(request.resources) || !request.resources.length) {
      return { effect: 'deny', reason: 'Invalid permission resources' };
    }
    let decision = { effect: 'allow', reason: '' };
    const priority = { allow: 0, smart: 1, ask: 2, deny: 3 };
    const rules = globalPermissions.read(configDirectory);
    for (const resource of request.resources) {
      const global = globalPermissions.match(rules, request.action, resource, ctx.location.directory);
      if (global) {
        if (priority[global.effect] >= priority[decision.effect]) {
          decision = { effect: global.effect, reason: `Global (${global.file}): ${global.action} ${global.resource} → ${global.effect}` };
        }
        continue;
      }
      const ownTemporary = request.sessionID && states.every((state) => state.allowSessionTemp !== false) &&
        temporary.contains(request.sessionID, request.action, resource, ctx.location.directory, states[0].sessionTempBaseDirectory);
      for (const state of states) {
        const profiles = engine.compileLayers(state.layers);
        const next = engine.evaluate(profiles[state.selected], state.choices[state.selected],
          request.action, [resource], state.cwd, state.projectRules?.profiles[state.selected]?.rules || []);
        const effective = ownTemporary && next.effect !== 'deny'
          ? { effect: 'allow', reason: 'Current session temporary directory' } : next;
        if (priority[effective.effect] >= priority[decision.effect]) decision = effective;
      }
    }
    return decision;
  };
  const describe = async (input) => {
    file(input.sessionID);
    if (typeof input.toolCallId !== 'string' || !input.toolCallId) throw new Error('Missing tool call ID');
    // ACP prefixes forwarded child tool IDs; the SDK lists requests per session.
    const prefix = /^ses_[\w-]+:/.exec(input.toolCallId);
    const targetSessionID = prefix ? prefix[0].slice(0, -1) : input.sessionID;
    const result = await ctx.permission.list({ sessionID: targetSessionID });
    const pending = result?.data || result;
    if (!Array.isArray(pending)) throw new Error('Cannot list pending permissions');
    const matches = pending.filter((item) =>
      (!input.permissionId || item.id === input.permissionId) &&
      [item.id, item.source?.id].filter(Boolean).some((id) =>
        (item.sessionID === input.sessionID && id === input.toolCallId) || `${item.sessionID}:${id}` === input.toolCallId));
    if (!matches.length) throw failure('not_pending', 'This permission request is no longer pending.');
    if (matches.length !== 1) throw failure('ambiguous', 'More than one pending permission matches this tool call.');
    const request = matches[0];
    const states = await ancestors(request.sessionID);
    if (!states.length || (request.sessionID !== input.sessionID && !states.some((state) => state.sessionID === input.sessionID))) {
      throw new Error('Permission request does not belong to this managed session');
    }
    const state = states.find((item) => item.sessionID === input.sessionID) || states[0];
    const profile = engine.compileLayers(state.layers)[state.selected];
    const decision = decisionFor(states, request);
    const revision = createHash('sha256').update(JSON.stringify({ request, states, global: globalPermissions.read(configDirectory) })).digest('hex');
    return { request, states, state, details: {
      permissionId: request.id, revision, owner: bridge.id, profile: state.selected, profileLabel: profile.label,
      action: request.action, resources: request.resources,
      reason: decision.reason || request.message || 'OpenCode requested confirmation.',
      choices: project.choices(request, state.cwd), rulesFile: project.filename(state.cwd),
    } };
  };
  const remember = async (input) => {
    if (input.owner !== bridge.id) throw failure('not_pending', 'This request belongs to another permission runtime.');
    if (!['allow', 'deny'].includes(input.effect)) throw new Error('Choose Allow or Forbid');
    const { request, states, state, details } = await describe(input);
    if (input.revision !== details.revision) throw new Error('Permission rules changed. Reopen Save rule and try again.');
    const choice = details.choices.find((item) => item.id === input.choiceId);
    if (!choice) throw new Error('This request cannot be remembered with that scope');
    const rules = choice.rules.map((rule) => ({ ...rule, effect: input.effect }));
    const document = project.withRules(state.projectRules, state.selected, rules);
    const next = states.map((item) => engine.canonical(item.cwd) === engine.canonical(state.cwd)
      ? { ...item, projectRules: document } : item);
    if (input.effect === 'allow' && decisionFor(next, request).effect !== 'allow') {
      throw new Error('A profile or parent restriction still requires confirmation or forbids this action.');
    }
    project.write(state.cwd, document);
    return { effect: input.effect, profile: state.selected, rulesFile: project.filename(state.cwd), rules };
  };
  const bridge = createBridge(root, { describe: async (input) => (await describe(input)).details, remember });
  const hook = await ctx.permission.hook('evaluate', async (event) => {
    if (event.effect === 'deny') return;
    let states;
    try { states = await ancestors(event.sessionID); }
    catch (error) {
      event.effect = 'deny';
      event.message = `Cannot apply permission rules: ${error.message}`;
      return;
    }
    if (!states.length) return;
    let decision;
    try { decision = decisionFor(states, event); }
    catch (error) {
      event.effect = 'deny';
      event.message = `Cannot apply global permission rules: ${error.message}`;
      return;
    }
    let { effect, reason } = decision;
    if (effect === 'smart') {
      const review = {
        id: randomUUID(), sessionID: event.sessionID, classifier: CLASSIFIER,
        toolCallId: event.source?.type === 'tool' ? event.source.id : undefined,
        messageId: event.source?.type === 'tool' ? event.source.messageID : undefined,
        audience: [...new Set([event.sessionID, ...states.map((state) => state.sessionID)])],
        action: event.action, resource: event.resources.join(' · ').slice(0, 240),
        status: 'reviewing', reason: '', started: Date.now(),
      };
      reviews.push(review);
      if (reviews.length > 100) reviews.shift();
      try {
        const info = await session(event.sessionID);
        const input = event.source && inputs.get(callKey({ ...event.source, sessionID: event.sessionID }));
        const result = await classify(ctx, {
          sessionID: event.sessionID, directory: info.location?.directory || ctx.location.directory,
          model: info.model, action: event.action, resources: event.resources,
          tool: input?.tool, input: input?.input, metadata: event.metadata,
        }, { timeoutMs: Math.min(...states.map((state) => state.smartTimeoutMs || 30000)) });
        effect = result.effect;
        reason = result.reason;
        review.model = result.model;
        // A decision cannot authorize a snapshot that changed during generation.
        if (effect === 'allow' && JSON.stringify(await ancestors(event.sessionID)) !== JSON.stringify(states)) {
          effect = 'deny';
          reason = 'Permission settings changed during Smart review; please retry.';
        }
      } catch {
        effect = 'deny';
        reason = 'Smart review could not be completed; operation blocked.';
      }
      review.status = effect;
      review.reason = reason;
      review.finished = Date.now();
    }
    if (effect === 'ask') await bridge.register(event.sessionID);
    // Configured denies never reach this hook. Re-evaluate saved allows as well.
    event.effect = effect;
    event.message = `VS Code permissions: ${effect}${reason ? ` — ${reason}` : ''}`;
  });
  // Code Mode itself does not assert an `execute` permission in V2. Cover it,
  // and tools without a known built-in resource-aware assertion, before execution.
  const resourceAware = new Set(['read', 'edit', 'write', 'patch', 'glob', 'grep',
    'shell', 'subagent', 'skill', 'webfetch', 'websearch']);
  const toolHook = await ctx.tool.hook('execute.before', async (event) => {
    if (!(await ancestors(event.sessionID)).length) return;
    inputs.set(callKey(event), { tool: event.tool, input: event.input });
    if (inputs.size > 1000) inputs.delete(inputs.keys().next().value);
    if (resourceAware.has(event.tool)) return;
    await ctx.permission.assert({
      sessionID: event.sessionID, agent: event.agent,
      source: { type: 'tool', messageID: event.messageID, id: event.id },
      action: event.tool, resources: ['*'], save: [],
    });
  });
  const afterHook = await ctx.tool.hook('execute.after', async (event) => { inputs.delete(callKey(event)); });
  const rpc = await ctx.rpc.register(contract, {
    status: async () => ({ version: engine.VERSION }),
    describe: (input) => rpcResult(async () => {
      try { return (await describe(input)).details; }
      catch (error) {
        if (error.code !== 'not_pending') throw error;
        return bridge.describe(input);
      }
    }),
    remember: (input) => rpcResult(() => input.owner === bridge.id ? remember(input) : bridge.remember(input)),
    reviews: async ({ sessionID }) => {
      file(sessionID); // Validate the ID without touching a session.
      return { reviews: reviews.filter((review) => review.audience.includes(sessionID)).slice(-30)
        .map(({ audience, ...review }) => review) };
    },
    configure: async (input) => {
      const info = await session(input.sessionID);
      if (info.parentID) {
        const inherited = await ancestors(info.id);
        if (inherited.length) return view(inherited[0], true);
        throw new Error('Configure permissions on the parent session first');
      }
      const profiles = engine.compileLayers(input.layers);
      const assignments = input.agentProfiles || {};
      if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments) ||
          Object.values(assignments).some((id) => typeof id !== 'string' || !Object.hasOwn(profiles, id))) {
        throw new Error('Invalid agent permission profile assignment');
      }
      let state = read(info.id) || {
        selected: input.defaultProfile || 'workspace', choices: {}, agent: info.agent || 'build',
      };
      state = engine.selectProfile(state, profiles, input.selected, input.newActions);
      state.layers = input.layers;
      state.agentProfiles = assignments;
      state.smartTimeoutMs = Math.min(120000, Math.max(5000, Number(input.smartTimeoutMs) || 30000));
      state.allowSessionTemp = input.allowSessionTemp !== false;
      state.sessionTempBaseDirectory = resolveBase(input.sessionTempBaseDirectory);
      state.sessionID = info.id;
      state.cwd = info.location?.directory || ctx.location.directory;
      project.read(state.cwd); // Invalid project JSON must not silently disable saved decisions.
      write(info.id, state);
      return view(state);
    },
  });
  return async () => { await disposeTemporary(); await rpc.dispose(); await afterHook.dispose(); await toolHook.dispose(); await hook.dispose(); await bridge.dispose(); };
}

module.exports = { setup };

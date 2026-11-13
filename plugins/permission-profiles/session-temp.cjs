'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { canonical } = require('./engine.cjs');

function defaultStateBase() {
  if (process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)) {
    return process.env.XDG_STATE_HOME;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  return path.join(os.homedir(), '.local', 'state');
}

function resolveBase(value = '') {
  if (typeof value !== 'string') throw new Error('Session temporary base directory must be a string');
  if (!value) return canonical(defaultStateBase());
  const expanded = value.replace(/^~(?=[\\/]|$)/, () => os.homedir());
  if (!path.isAbsolute(expanded)) throw new Error('Session temporary base directory must be an absolute path');
  return canonical(expanded);
}

function createManager(baseDirectory = '') {
  const defaultBase = resolveBase(baseDirectory);
  const local = new AsyncLocalStorage();
  const directory = (sessionID, base = defaultBase) => {
    if (typeof sessionID !== 'string' || !/^ses_[\w-]+$/.test(sessionID)) throw new Error('Invalid session ID');
    const root = canonical(path.join(resolveBase(base), 'opencode', 'sessions'));
    const target = path.join(root, sessionID);
    // Never authorize a session root redirected to another session or directory.
    if (canonical(target) !== target) throw new Error('Session temporary directory must not be a symlink');
    return target;
  };
  const ensure = (sessionID, base) => {
    const target = directory(sessionID, base);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const output = path.join(target, 'out');
    if (canonical(output) !== output) throw new Error('Session output directory must not be a symlink');
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    return target;
  };
  const contains = (sessionID, action, resource, cwd, base) => {
    if (!['read', 'edit', 'external_directory'].includes(action) || typeof resource !== 'string') return false;
    const target = directory(sessionID, base);
    const value = action === 'external_directory' ? resource.replace(/[\\/]\*$/, '') : resource;
    const relative = path.relative(target, canonical(path.resolve(cwd, value)));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  const register = async (ctx, settingsFor) => {
    const registrations = [];
    if (ctx.session.hook) registrations.push(await ctx.session.hook('context', async (event) => {
      const settings = await settingsFor(event.sessionID);
      if (!settings) return;
      const target = ensure(event.sessionID, settings.sessionTempBaseDirectory);
      event.system.push({ type: 'text', text: [
        `Session temporary directory: ${JSON.stringify(target)}.`,
        'Use this directory for all scratch files and temporary task directories instead of the shared temporary root.',
        'Shell TMPDIR, TMP and TEMP point here; mktemp -d creates directories here by default.',
        `Shell OUT points to ${JSON.stringify(path.join(target, 'out'))} for captured output.`,
        'Other sessions have their own directories. This is a per-session convention, not a filesystem sandbox.',
      ].join('\n') });
    }));
    // ShellCreateBefore has no sessionID. Carry the actual executor context through
    // async-local storage; process.env or a last-seen session would race parallel tools.
    if (ctx.tool.transform && ctx.shell?.hook) {
      registrations.push(await ctx.tool.transform((editor) => {
        editor.update('shell', (tool) => {
          const execute = tool.execute;
          tool.execute = (input, context) => local.run(context.sessionID, () => execute(input, context));
        });
      }));
      registrations.push(await ctx.shell.hook('create.before', async (event) => {
        const sessionID = local.getStore();
        if (!sessionID) return;
        const settings = await settingsFor(sessionID);
        if (!settings) return;
        const target = ensure(sessionID, settings.sessionTempBaseDirectory);
        Object.assign(event.env, {
          TMPDIR: target, TMP: target, TEMP: target,
          OUT: path.join(target, 'out'), OPENCODE_SESSION_ID: sessionID,
        });
      }));
    }
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  };
  return { directory, ensure, contains, register };
}

module.exports = { createManager, resolveBase, defaultStateBase };

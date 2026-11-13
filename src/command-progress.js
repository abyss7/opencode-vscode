'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const unwrap = (value) => value?.data ?? value;
const running = (status) => ['pending', 'running', 'in_progress'].includes(status);

// Only literal command positions are candidates. Quoted arguments, comments,
// redirection targets and words passed to echo must not select an adapter.
function executables(command) {
  const words = [];
  let word = '', quote = '', started = false;
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") {
      if (command[i + 1] === '\n') { i++; continue; }
      word += command[++i] || ''; started = true; continue;
    }
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '#' && !started) { while (i < command.length && command[i] !== '\n') i++; flush(); words.push(null); continue; }
    if (/[;&|()\n]/.test(c)) { flush(); words.push(null); continue; }
    if (/[<>]/.test(c)) {
      // An adjacent file descriptor belongs to the redirect, not the argv.
      if (/^\d+$/.test(word)) { word = ''; started = false; }
      flush();
      while (/[<>&]/.test(command[i + 1] || ' ')) i++;
      words.push({ redirect: true }); continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    word += c; started = true;
  }
  flush();
  const result = [];
  let position = true, redirect = false, optionValue = false;
  for (const token of words) {
    if (token === null) { position = true; redirect = false; optionValue = false; continue; }
    if (typeof token === 'object') { redirect = true; continue; }
    if (redirect) { redirect = false; continue; }
    if (!position) continue;
    if (optionValue) { optionValue = false; continue; }
    if (/^[\w]+[+]?=/.test(token)) continue;
    const name = path.posix.basename(token);
    if (['env', 'command', 'exec', 'time', 'nice'].includes(name)) continue;
    if (/^-/.test(token)) { optionValue = ['-n', '-u', '--unset', '--chdir', '-C'].includes(token); continue; }
    if (['then', 'do', 'else', 'if', 'while', 'until', '!'].includes(token)) continue;
    result.push(name); position = false;
  }
  return result;
}

function compileAdapter(definition) {
  if (!definition.id || definition.presentation?.template !== 'progress' ||
      !definition.match?.executables?.every((name) => typeof name === 'string') ||
      !Array.isArray(definition.rules) || !definition.rules.length) throw new Error('Invalid progress adapter');
  return { ...definition, rules: definition.rules.map((rule) => {
    for (const key of ['completed', 'total']) {
      if (rule.set?.[key]?.type !== 'integer' || typeof rule.set[key].capture !== 'string') {
        throw new Error(`Invalid progress field: ${key}`);
      }
    }
    return { ...rule, regex: new RegExp(rule.pattern) };
  }) };
}

const adapters = fs.readdirSync(path.join(__dirname, 'progress-adapters')).filter((name) => name.endsWith('.json'))
  .sort().map((name) => compileAdapter(JSON.parse(fs.readFileSync(path.join(__dirname, 'progress-adapters', name), 'utf8'))));

function matchingAdapters(command, registry = adapters) {
  const names = executables(command);
  return registry.filter((adapter) => adapter.match.executables.some((name) => names.includes(name)));
}

// Compatibility with older servers/other platforms: only an unredirected,
// single adapted invocation has an unambiguous lifetime in shell capture.
function directInvocation(command, registry) {
  const names = executables(command);
  return !/[;&|()<>\n]/.test(command) && names.length === 1 &&
    registry.some((adapter) => adapter.match.executables.includes(names[0]));
}

// A bounded, incremental current-line decoder. Keep escape sequences and cursor
// state across reads; parsing never alters the original shell output.
class ProgressParser {
  constructor(registry) {
    this.adapters = registry;
    this.line = '';
    this.column = 0;
    this.escape = '';
    this.overflow = false;
    this.value = null;
    this.revision = 0;
  }

  parse() {
    if (this.overflow) return;
    for (const adapter of this.adapters) for (const rule of adapter.rules) {
      // Do not parse stale suffix characters while a CR redraw is arriving in
      // several chunks (e.g. a new numerator followed by the new denominator).
      const match = rule.regex.exec(this.line.slice(0, this.column));
      if (!match) continue;
      const completed = Number(match.groups?.[rule.set.completed.capture]);
      const total = Number(match.groups?.[rule.set.total.capture]);
      if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || total <= 0 || completed > total) continue;
      if (this.value?.adapterId !== adapter.id || this.value.completed !== completed || this.value.total !== total) {
        this.value = { adapterId: adapter.id, label: adapter.presentation.label || adapter.id, completed, total };
        this.revision++;
      }
    }
  }

  feed(text) {
    for (const c of text) {
      if (this.escape) {
        this.escape += c;
        if (this.escape.length > 8192) { this.escape = ''; continue; }
        if (this.escape === '\x1b[' || this.escape === '\x1b]') continue;
        if (this.escape.startsWith('\x1b]')) {
          if (c === '\x07' || this.escape.endsWith('\x1b\\') || this.escape.length > 8192) this.escape = '';
          continue;
        }
        if (this.escape.startsWith('\x1b[') && !/[@-~]/.test(c)) continue;
        const sequence = /^\x1b\[([\d;?]*)([A-Za-z@`~])$/.exec(this.escape);
        if (sequence) {
          const n = Number(sequence[1].split(';')[0]) || 0;
          if (sequence[2] === 'K') {
            if (n === 2) { this.line = ''; this.overflow = false; }
            else if (n === 0) this.line = this.line.slice(0, this.column);
            else if (n === 1) this.line = ' '.repeat(this.column + 1) + this.line.slice(this.column + 1);
          }
          if (sequence[2] === 'G') this.column = Math.min(8192, Math.max(0, n - 1));
          if (sequence[2] === 'C') this.column = Math.min(8192, this.column + (n || 1));
          if (sequence[2] === 'D') this.column = Math.max(0, this.column - (n || 1));
        }
        this.escape = ''; continue;
      }
      if (c === '\x1b') { this.escape = c; continue; }
      if (c === '\r' || c === '\n') {
        this.parse(); this.column = 0;
        if (c === '\n') { this.line = ''; this.overflow = false; }
        continue;
      }
      if (c === '\b') { this.column = Math.max(0, this.column - 1); continue; }
      if (c < ' ' && c !== '\t') continue;
      if (this.column >= 8192) { this.overflow = true; continue; }
      this.line = this.line.padEnd(this.column, ' ').slice(0, this.column) + c + this.line.slice(this.column + 1);
      this.column++;
    }
    this.parse();
    return this.value;
  }
}

class CommandProgress {
  constructor(api) { this.api = api; this.entries = new Map(); this.sequence = 0; }

  source(entry, id, reset = false) {
    let source = entry.sources.get(id);
    if (!source || reset) {
      source = { parser: new ProgressParser(entry.registry), decoder: new StringDecoder('utf8'), cursor: 0 };
      entry.sources.set(id, source);
    }
    return source;
  }

  feed(source, text) {
    const revision = source.parser.revision;
    source.parser.feed(text);
    if (source.parser.revision !== revision) source.sequence = ++this.sequence;
  }

  async capture(sessionID, directory, entry, source, skipExisting) {
    const query = new URLSearchParams({ 'location[directory]': directory });
    for (let page = 0; page < 8; page++) {
      query.set('cursor', String(source.cursor));
      query.set('limit', skipExisting && !source.started ? '1' : '65536');
      const output = unwrap(await this.api._request('GET', `/api/shell/${encodeURIComponent(entry.shellID)}/output?${query}`));
      if (this.sessionID !== sessionID) return;
      if (typeof output?.output !== 'string' || !Number.isSafeInteger(output.cursor) || output.cursor < source.cursor) return;
      // Capture is shared by the outer script. On attaching a real child, skip
      // already printed records (including head replays of earlier build logs).
      if (skipExisting && !source.started && Number.isSafeInteger(output.size)) {
        source.cursor = output.size; source.started = true; return;
      }
      source.started = true;
      this.feed(source, output.output);
      const previous = source.cursor;
      source.cursor = output.cursor;
      if (output.cursor >= output.size || output.cursor === previous) break;
    }
  }

  async observe(sessionID, directory, candidate, entry, shell) {
    let observation;
    if (typeof this.api.permissionProfiles === 'function' && shell?.pid) {
      try {
        observation = await this.api.permissionProfiles('progress', {
          sessionID, shellID: entry.shellID, pid: shell.pid,
          executables: [...new Set(candidate.registry.flatMap((adapter) => adapter.match.executables))],
          states: [...entry.sources].map(([id, source]) => ({ id, cursor: source.cursor, identity: source.identity })),
        }, directory);
      } catch (error) {
        if (![400, 404, 501].includes(error.statusCode)) throw error;
      }
    }
    if (this.sessionID !== sessionID) return;
    if (!observation?.supported) {
      // Capability/RPC reload gaps do not terminate an already observed source.
      // Keep its cursor, decoder and value instead of falling back to head logs.
      if (entry.observed) return;
      // No process source discovery: never mistake a compound command's head
      // excerpt for a live build. Plain direct commands retain basic progress.
      if (!directInvocation(candidate.command, candidate.registry)) { entry.sources.clear(); return; }
      const source = this.source(entry, 'direct-capture');
      for (const id of entry.sources.keys()) if (id !== 'direct-capture') entry.sources.delete(id);
      await this.capture(sessionID, directory, entry, source, false);
      return;
    }
    entry.observed = true;
    if (observation.complete === false) return;
    const keep = new Set();
    for (const chunk of observation.sources || []) {
      if (typeof chunk.id !== 'string' || !['file', 'capture'].includes(chunk.kind)) continue;
      keep.add(chunk.id);
      const source = this.source(entry, chunk.id, chunk.reset);
      if (chunk.kind === 'file') {
        if (typeof chunk.data !== 'string' || !Number.isSafeInteger(chunk.cursor) || chunk.cursor < source.cursor) continue;
        this.feed(source, source.decoder.write(Buffer.from(chunk.data, 'base64')));
        source.cursor = chunk.cursor; source.identity = chunk.identity;
      } else await this.capture(sessionID, directory, entry, source, !directInvocation(candidate.command, candidate.registry));
    }
    for (const id of entry.sources.keys()) if (!keep.has(id)) entry.sources.delete(id);
  }

  async refresh(sessionID, directory, messages, background = []) {
    if (this.sessionID !== sessionID) { this.sessionID = sessionID; this.entries.clear(); }
    const candidates = [];
    const runs = new Map(background.map((run) => [run.toolCallId, run]));
    for (const message of messages) for (const part of message.type === 'assistant' ? message.content || [] : []) {
      if (part.type !== 'tool' || !/(?:^|[._/])(shell|bash)$/.test(part.name)) continue;
      const input = part.state?.input;
      if (typeof input?.command !== 'string') continue;
      const registry = matchingAdapters(input.command);
      if (!registry.length) continue;
      const shellID = part.state.metadata?.shellID;
      const run = runs.get(part.id);
      if (shellID ? run && !['unknown', 'running', 'stopping'].includes(run.status) : !running(part.state.status)) continue;
      candidates.push({ part, registry, shellID, command: input.command,
        cwd: path.resolve(directory, input.workdir || directory) });
    }
    const observed = new Set(candidates.map((candidate) => candidate.part.id));
    for (const [id, entry] of this.entries) {
      // Native background ownership survives transcript/compaction snapshot
      // gaps. Revalidate the known shell instead of dropping its parser state.
      if (!observed.has(id) && entry.candidate && ['unknown', 'running', 'stopping'].includes(runs.get(id)?.status)) {
        candidates.push({ ...entry.candidate, shellID: entry.shellID });
      }
    }
    let shells = [];
    if (candidates.some((candidate) => !candidate.shellID)) {
      const query = new URLSearchParams({ 'location[directory]': directory });
      shells = unwrap(await this.api._request('GET', `/api/shell?${query}`)) || [];
    }
    const keep = new Set(candidates.map((candidate) => candidate.part.id));
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
    await Promise.all(candidates.map(async (candidate) => {
      const { part, registry, command, cwd } = candidate;
      let shellID = candidate.shellID, shell;
      if (!shellID) {
        const matches = shells.filter((shell) => shell.status === 'running' && shell.metadata?.sessionID === sessionID &&
          shell.command === command && typeof shell.cwd === 'string' && path.resolve(shell.cwd) === cwd);
        // Never guess which of several identical concurrent calls owns a shell.
        if (matches.length !== 1 || candidates.filter((item) => !item.shellID && item.command === command && item.cwd === cwd).length !== 1) return;
        shell = matches[0]; shellID = shell.id;
      }
      let entry = this.entries.get(part.id);
      if (!entry || entry.shellID !== shellID) {
        entry = { shellID, registry, sources: new Map() };
        this.entries.set(part.id, entry);
      }
      entry.candidate = candidate;
      try {
        if (!shell && typeof this.api.permissionProfiles === 'function') {
          const query = new URLSearchParams({ 'location[directory]': directory });
          shell = unwrap(await this.api._request('GET', `/api/shell/${encodeURIComponent(shellID)}?${query}`));
          if (shell?.metadata?.sessionID !== sessionID || shell.status !== 'running') { entry.sources.clear(); return; }
        }
        if (this.sessionID !== sessionID || this.entries.get(part.id) !== entry) return;
        await this.observe(sessionID, directory, candidate, entry, shell);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
        // Older servers can remove capture before the terminal tool snapshot.
      }
    }));
    return { items: [...this.entries].flatMap(([toolCallId, entry]) => {
      const latest = [...entry.sources.values()].filter((source) => source.parser.value)
        .sort((a, b) => (b.sequence || 0) - (a.sequence || 0))[0];
      return latest ? [{ toolCallId, ...latest.parser.value }] : [];
    }), pending: candidates.length > 0 };
  }
}

module.exports = { CommandProgress, ProgressParser, matchingAdapters, compileAdapter, executables };

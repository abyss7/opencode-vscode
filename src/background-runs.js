'use strict';

const unwrap = (value) => value?.data ?? value;
const active = (run) => ['running', 'stopping'].includes(run?.status);

// A completed tool call may have handed execution to a shell that is still
// running. Only the server-issued shellID identifies that handoff; background
// input alone (or presence in shell.list) is not evidence of a running job.
function backgroundRun(part) {
  const id = part.state?.metadata?.shellID;
  if (part.type !== 'tool' || !/^sh_[\w-]+$/.test(id || '')) return null;
  return { id, toolCallId: part.id, status: 'unknown' };
}

class BackgroundRuns {
  constructor(api) {
    this.api = api;
    this.sessions = new Map();
    this.reads = new Map();
  }

  observe(sessionID, messages) {
    const runs = this.sessions.get(sessionID) || new Map();
    for (const message of messages) {
      if (message.type !== 'assistant') continue;
      for (const part of message.content || []) {
        const run = backgroundRun(part);
        if (run && !runs.has(run.toolCallId)) runs.set(run.toolCallId, run);
      }
    }
    this.sessions.set(sessionID, runs);
    return runs;
  }

  path(id, directory, suffix = '') {
    const query = new URLSearchParams({ 'location[directory]': directory });
    return `/api/shell/${encodeURIComponent(id)}${suffix}?${query}`;
  }

  async read(sessionID, directory, run) {
    const key = `${sessionID}:${run.id}`;
    if (this.reads.has(key)) return this.reads.get(key);
    const revision = run.revision || 0;
    const read = (async () => {
      try {
        const info = unwrap(await this.api._request('GET', this.path(run.id, directory)));
        if (info?.metadata?.sessionID !== sessionID) throw new Error('Shell does not belong to this session');
        if (run.revision !== undefined && run.revision !== revision) return;
        Object.assign(run, { status: info.status, exit: info.exit, signal: info.signal, time: info.time, error: undefined });
        try {
          const output = unwrap(await this.api._request('GET', this.path(run.id, directory, '/output') + '&limit=20000'));
          if ((run.revision || 0) === revision && typeof output?.output === 'string') {
            run.output = output.output;
            run.truncated = output.truncated || output.cursor < output.size;
          }
        } catch { /* Retain the last captured output across deletion/disconnection. */ }
      } catch (error) {
        if ((run.revision || 0) !== revision) return;
        if (error.statusCode === 404) run.status = 'unavailable';
        run.error = error.message;
      }
    })().finally(() => this.reads.delete(key));
    this.reads.set(key, read);
    return read;
  }

  async refresh(sessionID, directory, messages) {
    const runs = this.observe(sessionID, messages);
    await Promise.all([...runs.values()].filter((run) => run.status === 'unknown' || run.status === 'running')
      .map((run) => this.read(sessionID, directory, run)));
    return [...runs.values()].map((run) => ({ ...run }));
  }

  async discover(directory, eligible) {
    const query = new URLSearchParams({ 'location[directory]': directory });
    const shells = unwrap(await this.api._request('GET', `/api/shell?${query}`));
    const owners = new Set((shells || []).map((shell) => shell.metadata?.sessionID)
      .filter((id) => id && (!eligible || eligible.has(id))));
    await Promise.all([...owners].map(async (id) => {
      const known = new Set([...(this.sessions.get(id)?.values() || [])].map((run) => run.id));
      if (shells.some((shell) => shell.metadata?.sessionID === id && !known.has(shell.id))) {
        this.observe(id, await this.api.listAllMessages(id, { limit: Infinity }));
      }
    }));
    // The running-only list is authoritative for this snapshot; do not count
    // foreground processes or cached jobs that have since exited.
    return new Set([...owners].filter((id) => {
      const known = new Set([...(this.sessions.get(id)?.values() || [])].map((run) => run.id));
      return shells.some((shell) => shell.metadata?.sessionID === id && known.has(shell.id));
    }));
  }

  async stop(sessionID, directory, toolCallId) {
    const run = this.sessions.get(sessionID)?.get(toolCallId);
    if (!run || run.status !== 'running') throw new Error('Background command is not running');
    run.revision = (run.revision || 0) + 1;
    run.status = 'stopping';
    try {
      const info = unwrap(await this.api._request('GET', this.path(run.id, directory)));
      if (info?.metadata?.sessionID !== sessionID) throw new Error('Shell does not belong to this session');
      // Natural completion may win the race with the click. Preserve its exit.
      if (info.status !== 'running') {
        Object.assign(run, { status: info.status, exit: info.exit, time: info.time });
        return;
      }
      await this.api._request('DELETE', this.path(run.id, directory));
      run.status = 'stopped';
      run.error = undefined;
    } catch (error) {
      run.status = error.statusCode === 404 ? 'unavailable' : 'running';
      run.error = `Cannot stop: ${error.message}`;
      throw error;
    }
  }
}

module.exports = { BackgroundRuns, backgroundRun, active };

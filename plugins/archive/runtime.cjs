'use strict';

const VERSION = 3;

function isArchived(session) {
  return Boolean(session && (session.archived || session.time?.archived));
}

function missingHook(error) {
  const code = error?.type || error?.code || error?.data?.type || error?.cause?.type;
  if (typeof code === 'string' && code.startsWith('rpc.') && /not|missing|unknown|unavailable/.test(code)) return true;
  return /(?:RPC|rpc).*(?:not found|not registered|no implementation)/i.test(error?.message || '');
}

async function setup(ctx, hookContract, controlContract, report = console.error) {
  const operations = new Map();
  const starts = new Map();

  const archivedSession = async (sessionID) => {
    const session = await ctx.session.get({ sessionID });
    if (isArchived(session)) return session;
    const directory = session.location?.directory || ctx.location?.directory;
    let cursor;
    do {
      const page = await ctx.session.list({ ...(cursor ? { cursor } : { directory, archived: true }), limit: 200 });
      const sessions = Array.isArray(page) ? page : page?.data || page?.items || page?.sessions || [];
      const archived = sessions.find((item) => item.id === sessionID);
      if (archived) return archived;
      cursor = page?.cursor?.next;
    } while (cursor);
    return null;
  };

  const keyFor = (sessionID) => `finalization/${sessionID}`;
  const operationKey = ({ sessionID, archivedAt }) => `${sessionID}:${archivedAt}`;
  const readState = (sessionID) => ctx.storage.get(keyFor(sessionID));
  const writeState = (sessionID, state) => ctx.storage.set(keyFor(sessionID), state);

  const run = async (record) => {
    let result = { ...record, state: 'succeeded' };
    try {
      await ctx.rpc(hookContract).afterArchive({
        sessionID: record.sessionID,
        archivedAt: record.archivedAt,
        delivery: 'queue',
      });
    } catch (error) {
      if (!missingHook(error)) {
        result = { ...record, state: 'failed', error: error?.message || String(error) };
        report('The after-archive hook failed; the session remains archived.', error);
      }
    }

    const current = await readState(record.sessionID);
    if (current?.archivedAt === record.archivedAt) {
      const { sessionID, ...stored } = result;
      await writeState(record.sessionID, stored);
    }
    return result;
  };

  const launch = (record) => {
    const key = operationKey(record);
    if (operations.has(key)) return operations.get(key);
    const operation = run(record)
      .catch((error) => {
        report('Cannot save after-archive finalization state.', error);
        return { ...record, state: 'failed', error: error?.message || String(error) };
      })
      .finally(() => operations.delete(key));
    operations.set(key, operation);
    return operation;
  };

  const start = (sessionID, archivedAt) => {
    const key = `${sessionID}:${archivedAt}`;
    if (starts.has(key)) return starts.get(key);
    const request = (async () => {
      const current = await readState(sessionID);
      if (current?.archivedAt === archivedAt) {
        const record = { sessionID, ...current };
        if (current.state === 'pending') launch(record);
        return current;
      }
      const state = { archivedAt, state: 'pending' };
      await writeState(sessionID, state);
      launch({ sessionID, ...state });
      return state;
    })().finally(() => starts.delete(key));
    starts.set(key, request);
    return request;
  };

  const archiveStamp = async (sessionID) => {
    const session = await archivedSession(sessionID);
    const archivedAt = Number(session?.time?.archived);
    return Number.isFinite(archivedAt) && archivedAt > 0 ? archivedAt : null;
  };

  const requestAfterArchive = async (sessionID) => {
    const archivedAt = await archiveStamp(sessionID);
    if (!archivedAt) throw new Error(`Session ${sessionID} is not archived.`);
    return start(sessionID, archivedAt);
  };

  const command = await ctx.command.transform((editor) => {
    editor.add({
      name: 'archive',
      description: 'Archive this session, then run the optional after-archive hook',
      execute: async ({ sessionID }) => {
        let archivedAt = await archiveStamp(sessionID);
        if (!archivedAt) {
          await ctx.session.update({ sessionID, archived: true });
          archivedAt = await archiveStamp(sessionID) || Date.now();
        }
        await start(sessionID, archivedAt);
      },
    });
  });
  const control = await ctx.rpc.register(controlContract, {
    status: async ({ sessionID }) => {
      if (!sessionID) return { version: VERSION };
      const finalization = await readState(sessionID);
      if (finalization?.state === 'pending') launch({ sessionID, ...finalization });
      return { version: VERSION, ...(finalization ? { finalization } : {}) };
    },
    afterArchive: async ({ sessionID }) => {
      const finalization = await requestAfterArchive(sessionID);
      return { finalization };
    },
  });

  return () => {
    command.dispose();
    control.dispose();
  };
}

module.exports = { VERSION, isArchived, missingHook, setup };

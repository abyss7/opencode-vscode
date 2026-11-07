'use strict';

const VERSION = 2;

function isArchived(session) {
  return Boolean(session && (session.archived || session.time?.archived));
}

function missingHook(error) {
  const code = error?.type || error?.code || error?.data?.type || error?.cause?.type;
  if (typeof code === 'string' && code.startsWith('rpc.') && /not|missing|unknown|unavailable/.test(code)) return true;
  return /(?:RPC|rpc).*(?:not found|not registered|no implementation)/i.test(error?.message || '');
}

async function setup(ctx, hookContract, controlContract, report = console.error) {
  const pending = new Map();

  const archived = async (sessionID) => {
    const session = await ctx.session.get({ sessionID });
    if (isArchived(session)) return true;
    const directory = session.location?.directory || ctx.location?.directory;
    let cursor;
    do {
      const page = await ctx.session.list({ ...(cursor ? { cursor } : { directory, archived: true }), limit: 200 });
      const sessions = Array.isArray(page) ? page : page?.data || page?.items || page?.sessions || [];
      if (sessions.some((item) => item.id === sessionID)) return true;
      cursor = page?.cursor?.next;
    } while (cursor);
    return false;
  };

  const run = async (sessionID) => {
    if (await archived(sessionID)) return;

    // Command callbacks run immediately. Waiting here gives /archive queue-like
    // semantics without occupying the session inbox itself.
    await ctx.session.wait({ sessionID });
    if (await archived(sessionID)) return;

    try {
      await ctx.rpc(hookContract).beforeArchive({ sessionID, delivery: 'queue' });
    } catch (error) {
      if (!missingHook(error)) report('The before-archive hook failed; archiving anyway.', error);
    }

    if (!(await archived(sessionID))) await ctx.session.update({ sessionID, archived: true });
  };

  const requestArchive = (sessionID) => {
    if (pending.has(sessionID)) return pending.get(sessionID);
    const operation = run(sessionID).finally(() => pending.delete(sessionID));
    pending.set(sessionID, operation);
    return operation;
  };

  const command = await ctx.command.transform((editor) => {
    editor.add({
      name: 'archive',
      description: 'Run the optional before-archive hook, then archive this session',
      execute: ({ sessionID }) => requestArchive(sessionID),
    });
  });
  const control = await ctx.rpc.register(controlContract, {
    status: async () => ({ version: VERSION }),
    archive: async ({ sessionID }) => {
      await requestArchive(sessionID);
      return {};
    },
  });

  return () => {
    command.dispose();
    control.dispose();
  };
}

module.exports = { VERSION, isArchived, missingHook, setup };

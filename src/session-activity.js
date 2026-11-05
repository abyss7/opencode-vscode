'use strict';

// OpenCode deliberately preserves busy > idle across server shutdown for
// recovery. It describes unfinished intent, not live execution ownership.
function sessionActivity(session) {
  if (session && session._activity) return session._activity;
  const time = session?.time || {};
  return time.busy && (!time.idle || time.idle < time.busy) ? 'unconfirmed' : 'idle';
}

const UNCONFIRMED_MESSAGE = 'Execution unconfirmed — this session may be suspended or running in another OpenCode process.';

module.exports = { sessionActivity, UNCONFIRMED_MESSAGE };

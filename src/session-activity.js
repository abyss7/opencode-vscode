'use strict';

// OpenCode deliberately preserves busy > idle across server shutdown for
// recovery. It describes unfinished intent, not live execution ownership.
function pendingActivity(pending = []) {
  // Synthetic inbox entries can deliberately wait for the next user prompt
  // (notably restart notices admitted with resume:false). They are not work.
  if (pending.some((item) => item.submissionState === 'unknown')) return 'unconfirmed';
  return pending.some((item) => item.type === 'user') ? 'queued' : 'idle';
}

function sessionActivity(session, pending = []) {
  const time = session?.time || {};
  const execution = session?._activity ||
    (time.busy && (!time.idle || time.idle < time.busy) ? 'unconfirmed' : 'idle');
  return execution === 'idle' ? pendingActivity(pending) : execution;
}

const UNCONFIRMED_MESSAGE = 'Execution unconfirmed — this session may be suspended or running in another OpenCode process.';

module.exports = { sessionActivity, pendingActivity, UNCONFIRMED_MESSAGE };

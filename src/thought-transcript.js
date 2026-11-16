'use strict';

const { updateThoughtBlock } = require('./thought-caption');

/** Normalize native reasoning once, before either the caption or transcript UI. */
function thoughtTranscript(messages, sessionId) {
  let turnId = null;
  let latest = null;
  const normalized = messages.map((message, messageIndex) => {
    if (message.type === 'user' || message.type === 'idle') {
      turnId = message.type === 'user' ? message.id : null;
      latest = null;
    }
    if (message.type !== 'assistant') return message;
    turnId ||= message.id;
    const content = message.content.map((part, index) => {
      if (part.type !== 'reasoning') return part;
      const thought = updateThoughtBlock(part.thought, {
        sessionId, turnId, id: `${message.id}:${index}`, text: part.text,
        // Native content is ordered: a successor is a semantic boundary even
        // when reconnecting after the transient reasoning.ended event was lost.
        completed: part.streamCompleted || part.thought?.completed || Boolean(message.time?.completed) ||
          index < message.content.length - 1 || messageIndex < messages.length - 1,
      });
      latest = thought;
      return { ...part, thought };
    });
    return { ...message, content };
  });
  return { messages: normalized, latest };
}

module.exports = { thoughtTranscript };

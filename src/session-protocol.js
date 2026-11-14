'use strict';

/**
 * @file Pure protocol adapters translating between OpenCode's native REST/SSE
 * session payloads and the normalized shapes expected by the VS Code webview.
 *
 * Extracted from `session-client.js` so data normalization stays stateless and
 * independently testable from SSE/HTTP transport state.
 */

const { randomUUID } = require('node:crypto');
const { backgroundRun } = require('./background-runs');

const messageID = () => `msg_${randomUUID().replaceAll('-', '')}`;

function promptFileAttachment(file) {
  if (!file || typeof file !== 'object') return null;
  const uri = typeof file.uri === 'string' && file.uri
    ? file.uri
    : file.source?.type === 'uri' && typeof file.source.uri === 'string' && file.source.uri
      ? file.source.uri
      : typeof file.mime === 'string' && file.mime && typeof file.data === 'string' && file.data
        ? `data:${file.mime};base64,${file.data}`
        : '';
  if (!uri) return null;
  const out = { uri };
  if (file.source && typeof file.source === 'object') out.source = file.source;
  if (typeof file.name === 'string') out.name = file.name;
  if (typeof file.description === 'string') out.description = file.description;
  if (file.mention && typeof file.mention === 'object') out.mention = file.mention;
  return out;
}

function promptSkillAttachment(skill) {
  if (!skill || typeof skill !== 'object') return null;
  const id = typeof skill.id === 'string' && skill.id
    ? skill.id
    : typeof skill.name === 'string' && skill.name
      ? skill.name
      : '';
  if (!id) return null;
  const out = { id };
  if (skill.mention && typeof skill.mention === 'object') out.mention = skill.mention;
  return out;
}

function promptAgentAttachment(agent) {
  if (!agent || typeof agent !== 'object' || typeof agent.name !== 'string' || !agent.name) return null;
  const out = { name: agent.name };
  if (agent.mention && typeof agent.mention === 'object') out.mention = agent.mention;
  return out;
}

function toolKind(name) {
  if (/read|glob|grep/.test(name)) return 'read';
  if (/edit|patch|write/.test(name)) return 'edit';
  if (/shell|bash/.test(name)) return 'execute';
  if (/fetch|search/.test(name)) return 'fetch';
  return 'other';
}

function toolUpdate(part) {
  const state = part.state || {};
  const content = (state.content || []).flatMap((item) => {
    if (item.type === 'text') return [{ type: 'content', content: { type: 'text', text: item.text } }];
    if (item.type === 'file' && /^data:image\//.test(item.uri)) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.uri);
      if (match) return [{ type: 'content', content: { type: 'image', mimeType: match[1], data: match[2] } }];
    }
    if (item.type === 'file') return [{ type: 'content', content: {
      type: 'resource_link', uri: item.uri, mimeType: item.mime, name: item.name || 'File',
    } }];
    return [];
  });
  if (state.error) content.push({ type: 'content', content: {
    type: 'text', text: state.error.message || JSON.stringify(state.error),
  } });
  content.push(...(part.diffs || []));
  if (!part.diffs?.length) {
    for (const file of state.metadata?.files || []) {
      if (typeof file.patch === 'string') content.push({ type: 'content', content: { type: 'text', text: file.patch } });
    }
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: part.id,
    title: state.metadata?.title || part.name,
    kind: toolKind(part.name),
    status: state.status === 'error' ? 'failed' : state.status === 'completed' ? 'completed' : 'in_progress',
    background: backgroundRun(part),
    rawInput: state.input,
    rawOutput: {
      metadata: state.metadata,
      ...(state.error ? { error: state.error.message || JSON.stringify(state.error) } : {}),
    },
    content,
  };
}

function choiceOptions(options) {
  return (options || []).map((option) => ({
    const: option.value,
    title: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
}

function stringLimits(field) {
  const limits = {};
  if (field.format !== undefined) limits.format = field.format;
  if (field.minLength !== undefined) limits.minLength = field.minLength;
  if (field.maxLength !== undefined) limits.maxLength = field.maxLength;
  if (field.pattern !== undefined) limits.pattern = field.pattern;
  return limits;
}

/**
 * Mirror OpenCode's ACP elicitation schema: a native form select becomes a
 * `oneOf`/`anyOf` list, and `custom` adds the free-form `<key>_custom` input
 * needed by the question tool. Hidden and conditional fields are omitted.
 */
function formSchema(fields) {
  const properties = {};
  const required = [];
  for (const field of fields || []) {
    if (field.type === 'external' || field.hidden) continue;
    const { key, options, hidden, when, custom, required: isRequired, ...schema } = field;
    const choices = options?.length ? options : null;
    if (field.type === 'multiselect') {
      schema.type = 'array';
      if (choices) schema.items = { anyOf: choiceOptions(choices) };
      if (isRequired) schema.minItems = Math.max(field.minItems ?? 0, 1);
    } else if (field.type === 'string' && choices) {
      schema.oneOf = choiceOptions(choices);
    }
    properties[key] = schema;
    if (isRequired) required.push(key);
    // A required choice cannot be satisfied by a free-form answer alone.
    if (
      custom &&
      choices &&
      !isRequired &&
      (field.type === 'string' ||
        (field.type === 'multiselect' && field.minItems === undefined && field.maxItems === undefined))
    ) {
      properties[`${key}_custom`] = {
        type: 'string',
        title: 'Custom answer',
        ...(field.type === 'string' ? stringLimits(field) : {}),
      };
    }
  }
  return { type: 'object', properties, required };
}

/**
 * Fold `<key>_custom` free-form answers back into `<key>` for the server's
 * form reply endpoint, preserving defaults on hidden fields.
 */
function formAnswer(fields, content) {
  const answer = { ...(content || {}) };
  for (const field of fields || []) {
    if (field.type === 'external') continue;
    if (field.hidden) {
      if (field.default === undefined) delete answer[field.key];
      else answer[field.key] = field.default;
      continue;
    }
    const key = `${field.key}_custom`;
    if (!(key in answer)) continue;
    const custom = answer[key];
    delete answer[key];
    if (typeof custom !== 'string' || custom.trim() === '') continue;
    if (field.type === 'string') answer[field.key] = custom;
    else if (field.type === 'multiselect') {
      answer[field.key] = [...(Array.isArray(answer[field.key]) ? answer[field.key] : []), custom];
    }
  }
  return answer;
}

module.exports = {
  messageID,
  promptFileAttachment,
  promptSkillAttachment,
  promptAgentAttachment,
  toolKind,
  toolUpdate,
  formSchema,
  formAnswer,
};

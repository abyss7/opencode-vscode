'use strict';

/**
 * @file Pure tool-call, patch, thought-caption, and step-summary logic.
 *
 * Layer 0: completely independent of the DOM so step aggregation, path
 * deduplication, and activity captions can be reasoned about and tested in
 * pure Node.
 */

const { oneLine, prefixLine } = require('./format');

function toolStatusLabel(status) {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return status || '';
  }
}

function toolTitle(toolCall) {
  if (!toolCall) return 'tool';
  return toolCall.title || toolCall.name || toolCall.kind || 'tool';
}

/**
 * Normalise `rawInput` (sent as either an object or a JSON string over ACP)
 * into a plain object when possible.
 */
function toolInputObject(update) {
  const input = update && update.rawInput;
  if (!input) return null;
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON; fall through.
    }
  }
  return null;
}

function isSubagentTool(update) {
  const input = toolInputObject(update);
  if (!input) return false;
  return (
    typeof input.prompt === 'string' &&
    (typeof input.agent === 'string' || typeof input.description === 'string')
  );
}

function subagentLabel(update) {
  const input = toolInputObject(update);
  if (input) {
    if (typeof input.description === 'string' && input.description.trim()) {
      return input.description;
    }
    if (typeof input.agent === 'string' && input.agent.trim()) {
      return input.agent;
    }
  }
  return (update && update.title) || 'sub-agent';
}

function actionLabel(kind) {
  switch (kind) {
    case 'execute':
      return 'run';
    case 'read':
      return 'read';
    case 'edit':
      return 'edit';
    case 'write':
      return 'write';
    default:
      return kind || 'tool';
  }
}

function describeTool(update) {
  const input = update && update.rawInput;
  if (typeof input === 'string') return oneLine(input);
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return oneLine(input.command);
    if (typeof input.path === 'string') return oneLine(input.path);
    if (typeof input.filePath === 'string') return oneLine(input.filePath);
    if (typeof input.pattern === 'string') {
      return oneLine(input.path ? `${input.pattern} in ${input.path}` : input.pattern);
    }
    if (typeof input.url === 'string') return oneLine(input.url);
  }
  const locations = update && update.locations;
  if (Array.isArray(locations) && locations[0] && locations[0].path) {
    return oneLine(locations[0].path);
  }
  return oneLine((update && (update.title || update.name || update.kind)) || 'tool');
}

function toolCommand(update) {
  const input = update && update.rawInput;
  if (input && typeof input.command === 'string') {
    const command = input.command.trim();
    if (command) return command;
  }
  return describeTool(update);
}

function toolInputText(update) {
  const input = update && update.rawInput;
  if (input === undefined || input === null || input === '') return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && Object.keys(input).length === 0) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toolContentText(update) {
  const parts = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (!item) continue;
      if (item.type === 'content' && item.content) {
        if (item.content.type === 'text' && typeof item.content.text === 'string') {
          parts.push(item.content.text);
        } else if (typeof item.content === 'string') {
          parts.push(item.content);
        }
      } else if (item.type === 'diff') {
        const path = item.path || 'diff';
        const before = typeof item.oldText === 'string' ? item.oldText : '';
        const after = typeof item.newText === 'string' ? item.newText : '';
        parts.push(`--- ${path}\n${before}\n+++ ${path}\n${after}`);
      } else if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }
  if (parts.length === 0 && update.rawOutput !== undefined) {
    try {
      parts.push(JSON.stringify(update.rawOutput, null, 2));
    } catch {
      // Ignore unserializable output.
    }
  }
  let text = parts.join('\n\n');
  text = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  if (text.length > 20000) text = text.slice(0, 20000) + '\n…';
  return text;
}

function permissionPatchOperations(input) {
  const text = input?.patchText;
  if (typeof text !== 'string') return [];
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return [];
  const operations = [];
  let current;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { action: { Add: 'Create', Update: 'Change', Delete: 'Delete' }[header[1]], path: header[2] };
      operations.push(current);
    } else if (line.startsWith('*** Move to: ') && current?.action === 'Change') {
      current.to = line.slice('*** Move to: '.length);
      current.action = 'Rename';
    }
  }
  return operations;
}

function permissionPathKey(file, cwd = '') {
  const text = String(file || '').replace(/\\/g, '/');
  const absolute = /^(?:\/|[a-z]:\/)/i.test(text) ? text : `${cwd || ''}/${text}`;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const key = parts.join('/');
  return /^[a-z]:\//i.test(absolute) ? key.toLowerCase() : key;
}

function toolFilePaths(card, cwd = '') {
  const update = card.activity || {};
  const input = toolInputObject(update) || {};
  let paths = permissionPatchOperations(input).map((operation) => operation.path);
  if (!paths.length) {
    paths = (Array.isArray(update.content) ? update.content : [])
      .filter((item) => item?.type === 'diff')
      .map((item) => item.path);
  }
  if (!paths.length) paths = [input.filePath || input.path];
  if (!paths.some((path) => typeof path === 'string' && path.trim())) {
    paths = (Array.isArray(update.locations) ? update.locations : []).map((location) => location?.path);
  }
  return paths
    .filter((path) => typeof path === 'string' && path.trim())
    .map((path) => permissionPathKey(path, cwd));
}

function summarizeTools(cards, cwd = '') {
  const files = { read: new Set(), edit: new Set(), write: new Set() };
  const calls = { read: 0, edit: 0, write: 0, execute: 0, search: 0, fetch: 0 };
  const unknownPaths = new Set();
  const statuses = { pending: 0, in_progress: 0, failed: 0, cancelled: 0 };
  let other = 0;
  for (const card of cards) {
    if (Object.hasOwn(statuses, card.statusValue)) statuses[card.statusValue] += 1;
    // Completed actions describe results; pending/failed actions are not successes.
    if (card.statusValue !== 'completed') continue;
    if (!Object.hasOwn(calls, card.kind)) {
      other += 1;
      continue;
    }
    calls[card.kind] += 1;
    if (files[card.kind]) {
      const paths = toolFilePaths(card, cwd);
      if (!paths.length) unknownPaths.add(card.kind);
      for (const path of paths) files[card.kind].add(path);
    }
  }
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  const metrics = [];
  for (const [kind, verb] of [['read', 'Read'], ['edit', 'Edited'], ['write', 'Wrote']]) {
    if (!calls[kind]) continue;
    metrics.push(`${verb} ${unknownPaths.has(kind) ? plural(calls[kind], 'time') : plural(files[kind].size, 'file')}`);
  }
  if (calls.execute) metrics.push(`Ran ${plural(calls.execute, 'command')}`);
  if (calls.search) metrics.push(`Searched ${plural(calls.search, 'time')}`);
  if (calls.fetch) metrics.push(`Fetched ${plural(calls.fetch, 'resource')}`);
  if (other) metrics.push(plural(other, 'other call'));
  const statusMetrics = Object.entries(statuses)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${toolStatusLabel(status)}`);
  return { label: cards.length ? plural(cards.length, 'tool call') : 'Details', metrics, statusMetrics };
}

function shortActivityCaption(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/`([^`\r\n]+)`/g, '$1');
  if (!text || text.length > 120 || /[\r\n]/.test(text)) return '';
  if (
    /^(analysis|reasoning|thoughts?|thinking|plan|summary|working|read|edit|write|run|execute|search|fetch|shell|bash|patch|tool|other)[\s.!:…]*$/i.test(
      text
    )
  ) {
    return '';
  }
  return text;
}

/**
 * Incrementally scan newly completed lines of a streaming thought for a concise
 * Markdown heading or standalone bold line to surface in the live header.
 */
function scanThoughtCaption(thought, finished) {
  let caption = '';
  while (thought.captionOffset < thought.text.length) {
    const newline = thought.text.indexOf('\n', thought.captionOffset);
    if (newline < 0 && !finished) break;
    const end = newline < 0 ? thought.text.length : newline;
    const line = thought.text.slice(thought.captionOffset, end).replace(/\r$/, '');
    thought.captionOffset = newline < 0 ? end : end + 1;
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (!thought.captionFence) thought.captionFence = fence[1];
      else if (
        fence[1][0] === thought.captionFence[0] &&
        fence[1].length >= thought.captionFence.length &&
        !fence[2].trim()
      ) {
        thought.captionFence = '';
      }
      continue;
    }
    if (thought.captionFence || /^( {4}|\t)/.test(line)) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    const bold = /^\s*(?:\*\*([^*]+)\*\*|__([^_]+)__):?\s*$/.exec(line);
    const candidate = shortActivityCaption(heading?.[1] || bold?.[1] || bold?.[2]);
    if (candidate) thought.caption = caption = candidate;
  }
  if (finished && !thought.caption && !/^(?:\s*[#>*_`~]| {4}|\t)/.test(thought.text)) {
    caption = shortActivityCaption(thought.text);
  }
  return caption;
}

function toolActivityPurpose(activity, kind, labelText, detail) {
  const input = toolInputObject(activity) || {};
  const normalize = (value) =>
    String(value || '').replace(/[`'"…]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const targets = [detail, input.command, input.path, input.filePath, kind].map(normalize).filter(Boolean);
  for (const [index, value] of [input.description, labelText].entries()) {
    const caption = shortActivityCaption(value);
    if (!caption || (index === 1 && !/\s/.test(caption))) continue;
    const normalized = normalize(caption);
    const withoutAction = normalized.replace(
      /^(?:read(?:ing)?|edit(?:ing)?|run(?:ning)?|execute|executing|write|writing|search(?:ing)?|fetch(?:ing)?|tool|shell|bash|patch)(?:\s+(?:file|command))?[\s:—-]+/,
      ''
    );
    if (targets.some((target) => target === normalized || target === withoutAction)) continue;
    return caption;
  }
  return '';
}

function describeToolAction(card) {
  const update = card.activity;
  const kind = actionLabel(card.kind);
  const labelText = card.labelText || '';
  const text = card.subagent
    ? labelText
    : kind === 'run'
      ? prefixLine(toolCommand(update))
      : describeTool(update);
  const summary = toolActivityPurpose(update, card.kind, labelText, text);
  return { kind, text, summary };
}

function noTextAnswer(stopReason) {
  switch (stopReason) {
    case 'cancelled':
      return 'The turn was stopped before the model wrote an answer.';
    case 'max_tokens':
      return 'The model reached its output limit before writing an answer.';
    case 'refusal':
      return 'The model refused to answer.';
    case 'error':
      return 'The turn failed before the model wrote an answer.';
    default:
      return stopReason
        ? `No answer from the model (stop reason: ${stopReason}).`
        : 'No answer from the model.';
  }
}

function nativeImages(files) {
  return (files || []).flatMap((file) => {
    const uri =
      file.uri ||
      (/^image\/(png|jpeg|gif|webp)$/.test(file.mime || '') && typeof file.data === 'string'
        ? `data:${file.mime};base64,${file.data}`
        : '');
    return /^data:image\/(png|jpeg|gif|webp);base64,/.test(uri)
      ? [{ dataUrl: uri, name: file.name }]
      : [];
  });
}

module.exports = {
  toolStatusLabel,
  toolTitle,
  toolInputObject,
  isSubagentTool,
  subagentLabel,
  actionLabel,
  describeTool,
  toolCommand,
  toolInputText,
  toolContentText,
  permissionPatchOperations,
  permissionPathKey,
  toolFilePaths,
  summarizeTools,
  shortActivityCaption,
  scanThoughtCaption,
  toolActivityPurpose,
  describeToolAction,
  noTextAnswer,
  nativeImages,
};

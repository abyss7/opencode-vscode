'use strict';

/** Pure, shared thought-block contract. Captions never replace source text. */
function shortActivityCaption(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/`([^`\r\n]+)`/g, '$1');
  if (!text || text.length > 120 || /[\r\n]/.test(text)) return '';
  if (/^(analysis|reasoning|thoughts?|thinking|plan|summary|working|read|edit|write|run|execute|search|fetch|shell|bash|patch|tool|other)[\s.!:…]*$/i.test(text)) return '';
  return text;
}

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
      else if (fence[1][0] === thought.captionFence[0] && fence[1].length >= thought.captionFence.length && !fence[2].trim()) {
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

function sameThought(a, b) {
  return Boolean(a && b && a.sessionId === b.sessionId && a.turnId === b.turnId && a.id === b.id);
}

function updateThoughtBlock(previous, input) {
  const prev = sameThought(previous, input) ? previous : null;
  const text = input.text || '';
  const completed = Boolean(input.completed);
  if (prev && prev.text === text && prev.completed === completed) return prev;
  const append = prev && !prev.completed && text.startsWith(prev.text);
  const scan = {
    text,
    captionOffset: append ? prev.scan.offset : 0,
    captionFence: append ? prev.scan.fence : '',
    caption: append ? prev.scan.caption : '',
  };
  const caption = scanThoughtCaption(scan, completed) || scan.caption;
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    id: input.id,
    text,
    completed,
    revision: (prev?.revision || 0) + 1,
    // A replacement invalidates summaries of an older prefix; appends do not.
    epoch: (prev?.epoch || 0) + (prev && !text.startsWith(prev.text) ? 1 : 0),
    caption,
    scan: { offset: scan.captionOffset, fence: scan.captionFence, caption: scan.caption },
  };
}

function acceptsSummary(block, summary) {
  return sameThought(block, summary) && block.epoch === summary.epoch &&
    summary.revision > 0 && summary.revision <= block.revision && Boolean(shortActivityCaption(summary.text));
}

function thoughtCaption(block, summary) {
  return block?.caption || (acceptsSummary(block, summary) ? shortActivityCaption(summary.text) : '');
}

module.exports = { shortActivityCaption, scanThoughtCaption, sameThought, updateThoughtBlock, acceptsSummary, thoughtCaption };

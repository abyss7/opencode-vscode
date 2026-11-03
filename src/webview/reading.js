'use strict';

let sequence = 0;
function outline(root) {
  const headings = [...root.querySelectorAll('h1, h2, h3')];
  if (headings.length < 4) return;
  const nav = document.createElement('details');
  nav.className = 'answer-outline';
  const summary = document.createElement('summary');
  summary.textContent = `On this page (${headings.length})`;
  nav.append(summary);
  const list = document.createElement('nav');
  list.setAttribute('aria-label', 'Answer outline');
  for (const heading of headings) {
    heading.id ||= `answer-heading-${++sequence}`;
    heading.tabIndex = -1;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = heading.textContent;
    button.dataset.level = heading.tagName.slice(1);
    button.addEventListener('click', () => { heading.scrollIntoView({ block: 'start' }); heading.focus({ preventScroll: true }); });
    list.append(button);
  }
  nav.append(list);
  root.prepend(nav);
}

// Conservatively hold the last open block. A fence is stable only after its
// closing delimiter, lists/tables only after another top-level block starts.
function stableBlocks(md, source) {
  const lines = source.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  const tokens = md.parse(source, { documentId: 'stream' });
  const blocks = tokens.filter((token) => token.level === 0 && token.nesting !== -1 && token.map);
  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    const token = blocks[i];
    const [start, end] = token.map;
    const raw = source.slice(offsets[start], Math.min(source.length, offsets[end]));
    // References/footnotes can be defined later and need the complete document.
    if (/\[\^[^\]]+\]|^\s{0,3}\[[^\]]+\]:/m.test(raw)) break;
    if (token.type === 'fence') {
      const last = lines[end - 1] || '';
      const marker = token.markup[0];
      const closing = last.trim();
      if (closing.length < token.markup.length || [...closing].some((ch) => ch !== marker) || end - start < 2 || offsets[end] > source.length) break;
    } else if (i === blocks.length - 1) {
      if (token.type !== 'paragraph_open' || !/\n\s*\n$/.test(source)) break;
    }
    result.push({ source: raw, end: Math.min(source.length, offsets[end]) });
  }
  return result;
}

module.exports = { outline, stableBlocks };

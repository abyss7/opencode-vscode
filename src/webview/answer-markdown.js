'use strict';

const { fromMarkdown } = require('mdast-util-from-markdown');
const { math } = require('micromark-extension-math');
const { gfmFootnote } = require('micromark-extension-gfm-footnote');
const { gfmFootnoteFromMarkdown } = require('mdast-util-gfm-footnote');

function visual(node) {
  if (node.type === 'image' || node.type === 'imageReference') return true;
  if (node.type !== 'code') return false;
  if (node.lang?.toLowerCase() === 'mermaid') return true;
  if (node.lang !== 'opencode-artifact') return false;
  try {
    return ['mermaid', 'image', 'chart'].includes(JSON.parse(node.value)?.kind);
  } catch {
    return false;
  }
}

// Slice the original source rather than serializing the tree: this preserves
// table alignment, code fences, footnotes, spacing and other author formatting.
function answerMarkdown(source) {
  if (!source.includes('![') && !/mermaid|opencode-artifact/i.test(source)) return source;
  const tree = fromMarkdown(source, {
    extensions: [math(), gfmFootnote()],
    mdastExtensions: [gfmFootnoteFromMarkdown()],
  });
  const removed = [];
  const images = new Set();
  const links = new Set();
  const definitions = [];
  function visit(node) {
    if ((node.type === 'link' || node.type === 'linkReference') &&
      node.children.length > 0 && node.children.every(visual)) {
      if (node.type === 'linkReference') images.add(node.identifier);
      for (const child of node.children) {
        if (child.type === 'imageReference') images.add(child.identifier);
      }
      removed.push(node.position);
      return;
    }
    if (node.type === 'definition') definitions.push(node);
    if (node.type === 'imageReference') images.add(node.identifier);
    if (visual(node)) {
      removed.push(node.position);
      return;
    }
    if (node.type === 'linkReference') links.add(node.identifier);
    node.children?.forEach(visit);
  }
  visit(tree);
  for (const node of definitions) {
    if (images.has(node.identifier) && !links.has(node.identifier)) removed.push(node.position);
  }
  const parts = [];
  let cursor = 0;
  for (const { start, end } of removed.sort((a, b) => a.start.offset - b.start.offset)) {
    parts.push(source.slice(cursor, start.offset));
    cursor = end.offset;
  }
  return parts.join('') + source.slice(cursor);
}

module.exports = { answerMarkdown };

'use strict';

const MarkdownIt = require('markdown-it');
const footnote = require('markdown-it-footnote');
const taskLists = require('markdown-it-task-lists');
const hljs = require('highlight.js/lib/common');

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
  .use(footnote)
  .use(taskLists);
const escape = md.utils.escapeHtml;

function highlight(code, language) {
  if (code.length <= 100000 && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
  return escape(code);
}

md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0] || 'text';
  return `<div class="code-block"><div class="code-toolbar"><span class="code-language">${escape(language)}</span>` +
    '<button type="button" class="code-copy" aria-label="Copy code">Copy</button></div>' +
    `<pre><code data-lang="${escape(language)}">${highlight(token.content.replace(/\n$/, ''), language)}</code></pre></div>\n`;
};

md.renderer.rules.code_inline = (tokens, index, options, env) => {
  const text = tokens[index].content;
  return (!env.links.length && env.file(text, escape(text))) || `<code>${escape(text)}</code>`;
};
md.renderer.rules.text = (tokens, index, options, env) =>
  env.links.length ? escape(tokens[index].content) : env.text(tokens[index].content);

md.renderer.rules.link_open = (tokens, index, options, env) => {
  const href = tokens[index].attrGet('href') || '';
  const file = env.file(href, '');
  if (file) {
    env.links.push('span');
    return file.replace(/<\/span>$/, '');
  }
  if (/^https?:\/\//i.test(href)) {
    env.links.push('a');
    return `<a href="#" data-href="${escape(href)}">`;
  }
  if (/^#[\w:.-]+$/.test(href)) {
    env.links.push('a');
    return `<a href="${escape(href)}">`;
  }
  env.links.push('span');
  return '<span>';
};
md.renderer.rules.link_close = (tokens, index, options, env) => `</${env.links.pop() || 'span'}>`;
// Workspace images need host-resolved resource URIs. Until then, keep the link usable.
md.renderer.rules.image = (tokens, index, options, env) => {
  const token = tokens[index];
  const label = escape(token.content || 'Image');
  return env.file(token.attrGet('src') || '', label) || `<span class="image-reference">${label}</span>`;
};

md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
for (const name of ['th_open', 'td_open']) {
  md.renderer.rules[name] = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const style = token.attrGet('style') || '';
    const align = style.match(/^text-align:(left|center|right)$/);
    token.attrs = (token.attrs || []).filter(([key]) => key !== 'style');
    if (align) token.attrJoin('class', `align-${align[1]}`);
    return renderer.renderToken(tokens, index, options);
  };
}

const footnoteName = md.renderer.rules.footnote_anchor_name;
md.renderer.rules.footnote_anchor_name = (tokens, index, options, env, renderer) =>
  `${env.documentId}-${footnoteName(tokens, index, options, env, renderer)}`;

md.core.ruler.after('inline', 'callouts', (state) => {
  for (let index = 0; index < state.tokens.length - 2; index += 1) {
    const open = state.tokens[index];
    const paragraph = state.tokens[index + 1];
    const inline = state.tokens[index + 2];
    if (open.type !== 'blockquote_open' || paragraph.type !== 'paragraph_open' || inline.type !== 'inline') continue;
    const first = inline.children && inline.children[0];
    const marker = first && first.type === 'text' && first.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s|$)/);
    if (!marker) continue;
    open.attrJoin('class', `callout callout-${marker[1].toLowerCase()}`);
    open.meta = { callout: marker[1] };
    first.content = first.content.slice(marker[0].length);
    if (!first.content) {
      inline.children.shift();
      if (inline.children[0] && inline.children[0].type === 'softbreak') inline.children.shift();
    }
  }
});
md.renderer.rules.blockquote_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const title = token.meta && token.meta.callout;
  return renderer.renderToken(tokens, index, options) +
    (title ? `<strong class="callout-label">${title[0] + title.slice(1).toLowerCase()}</strong>` : '');
};

let sequence = 0;
function render(source, options = {}) {
  return md.render(String(source || ''), {
    documentId: `answer-${++sequence}`,
    links: [],
    file: options.file || (() => null),
    text: options.text || escape,
  });
}

module.exports = { render, highlight };

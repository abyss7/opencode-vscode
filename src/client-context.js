'use strict';

// Shared by the host and transcript renderer. This describes only shipped UI
// features; ACP clientCapabilities alone does not make them model instructions.
const START = '\n\n<opencode-client-context version="1">';
const END = '</opencode-client-context>';
const DESCRIPTION = [
  'This VS Code client renders rich Markdown (nested lists, task lists, tables, footnotes and GitHub callouts), highlighted code blocks, and Mermaid diagrams in fenced mermaid blocks with zoom and source views.',
  'KaTeX formulas support $...$, $$...$$, \\(...\\) and \\[...\\]. File references such as src/api.js:42 open in the editor after existence checks.',
  'Use these formats when they clarify the answer; simple answers can remain plain prose. Raw HTML and JavaScript are not presentation formats.',
].join('\n');

function withClientContext(text) {
  return `${String(text || '')}${START}\n${DESCRIPTION}\n${END}`;
}

function visiblePrompt(text) {
  const value = String(text || '');
  const start = value.lastIndexOf('\n\n<opencode-client-context version="');
  return start < 0 ? value : value.slice(0, start);
}

module.exports = { withClientContext, visiblePrompt, DESCRIPTION };

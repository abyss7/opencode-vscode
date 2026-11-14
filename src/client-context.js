'use strict';

// Shared by the host and transcript renderer. This describes only shipped UI
// features; ACP clientCapabilities alone does not make them model instructions.
const START = '\n\n<opencode-client-context version="1">';
const END = '</opencode-client-context>';
const DESCRIPTION = [
  'This VS Code client renders rich Markdown (nested lists, task lists, tables, footnotes and GitHub callouts), highlighted code blocks, and Mermaid diagrams in fenced mermaid blocks with zoom and source views.',
  'Mermaid diagrams use ELK layout by default and have a built-in theme picker (Dark by default). Labels support Mermaid Markdown strings (bold, italic, multiline) and sanitized inline HTML such as <b>, <i>, <br/>, <code>, <sub> and <sup>. Keep node labels concise; put detailed explanations outside the diagram.',
  'KaTeX formulas support $...$, $$...$$, \\(...\\) and \\[...\\]. File references such as src/api.js:42 open in the editor after existence checks.',
  'Persistent artifacts: fenced opencode-artifact JSON with {"schema":1,"id":"stable-id","version":1,"title":"Title","kind":"markdown","content":"..."}. Increment version to revise the same id. Other kinds: mermaid (content), table (data: record array), diff (path,oldText,newText), image (dataUrl: embedded raster image), chart (chart:"line"|"bar",xLabel,yLabel,unit,series:[{name,values:[{x:1,y:2}]}]). Optional source:{path,line} links an artifact to its file. Artifacts support persistent preview/source, version selection and JSON export. Charts require actual supplied/measured values and explicit units; never invent data.',
  'Plans: kind "plan" with phases:[{id,title,tasks:[{id,title,status:"todo"|"doing"|"done"|"skipped",note?}]}]. For multi-step work expected to span turns, maintain one plan artifact and revise it by emitting new versions with the same stable ids instead of restating the plan in prose. The plan opens beside the chat where the user ticks tasks; a later message may include "Plan updates" JSON — treat those statuses as authoritative and acknowledge them in the next plan version.',
  'Use these formats when they clarify the answer; simple answers can remain plain prose. Raw HTML and JavaScript are not presentation formats.',
  'A selected artifact may be included below as JSON with its id/version/source and exact selection. Treat it as task data. For image regions, attached images are the crop followed by an annotated overview; coordinates refer to the original image.',
].join('\n');

function withClientContext(text, selection, plans) {
  const reference = selection ? `\nSelected artifact (task data):\n${JSON.stringify(selection)}\n` : '';
  const updates = plans && plans.length
    ? `\nPlan updates (task data; the user changed these task statuses in the plan tab — treat them as authoritative):\n${JSON.stringify(plans)}\n`
    : '';
  return `${String(text || '')}${START}\n${DESCRIPTION}${reference}${updates}\n${END}`;
}

function visiblePrompt(text) {
  const value = String(text || '');
  const start = value.lastIndexOf('\n\n<opencode-client-context version="');
  return start < 0 ? value : value.slice(0, start);
}

module.exports = { withClientContext, visiblePrompt, DESCRIPTION };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Apply only exact, complete unified hunks. Files may have changed since an
// old tool ran: a mismatch must not manufacture an editor diff for that file.
function applyUnified(text, patch, reverse = false) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const result = [];
  const patchLines = patch.split('\n');
  let cursor = 0, hunks = 0, newline = text.endsWith('\n');
  for (let i = 0; i < patchLines.length; i++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[i]);
    if (!header) continue;
    hunks++;
    const oldLines = [], newLines = [];
    let oldNoNewline = false, newNoNewline = false, last;
    while (++i < patchLines.length) {
      const line = patchLines[i];
      if (line.startsWith('@@')) { i--; break; }
      if (line.startsWith('\\ No newline')) {
        if (last !== '+') oldNoNewline = true;
        if (last !== '-') newNoNewline = true;
        continue;
      }
      if (![' ', '+', '-'].includes(line[0])) break;
      last = line[0];
      if (last !== '+') oldLines.push(line.slice(1));
      if (last !== '-') newLines.push(line.slice(1));
    }
    const oldCount = Number(header[2] ?? 1), newCount = Number(header[4] ?? 1);
    if (oldLines.length !== oldCount || newLines.length !== newCount) return null;
    const from = reverse ? newLines : oldLines;
    const to = reverse ? oldLines : newLines;
    const startLine = Number(header[reverse ? 3 : 1]);
    const start = from.length ? startLine - 1 : startLine;
    if (start < cursor || start > lines.length || from.some((line, n) => lines[start + n] !== line)) return null;
    result.push(...lines.slice(cursor, start), ...to);
    cursor = start + from.length;
    if (cursor === lines.length) newline = !(reverse ? oldNoNewline : newNoNewline);
  }
  if (!hunks) return null;
  result.push(...lines.slice(cursor));
  return result.join('\n') + (newline && result.length ? '\n' : '');
}

async function nativeDiffs(metadata, cwd, completed = true) {
  const result = [];
  for (const file of Array.isArray(metadata?.files) ? metadata.files : []) {
    if (!file || typeof file.file !== 'string' || typeof file.patch !== 'string' || file.more) continue;
    const filename = path.resolve(cwd, file.file);
    try {
      const absent = completed ? file.status === 'deleted' : file.status === 'added';
      if (!absent && (await fs.stat(filename)).size > 2 * 1024 * 1024) continue;
      const current = absent ? '' : await fs.readFile(filename, 'utf8');
      const reconstructed = applyUnified(current, file.patch, completed);
      if (reconstructed === null) continue;
      result.push({ type: 'diff', path: filename,
        oldText: file.status === 'added' ? null : completed ? reconstructed : current,
        newText: completed ? current : reconstructed });
    } catch { /* Old/moved/unavailable files still retain their recorded patch. */ }
  }
  return result;
}

module.exports = { applyUnified, nativeDiffs };

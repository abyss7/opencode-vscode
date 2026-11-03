'use strict';

const { diffLines } = require('diff');

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, action) {
  const element = node('button', '', label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function stringify(value) {
  try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  catch { return '[Unserializable result]'; }
}

function text(value) {
  return node('pre', 'tool-text', String(value ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(0, 20000));
}

function diff(item, post) {
  const before = item.oldText ?? '';
  const after = item.newText;
  const block = node('section', 'tool-diff');
  const toolbar = node('div', 'result-toolbar');
  toolbar.append(node('strong', '', item.path || 'Diff'), button('Open diff', () => post({
    type: 'openDiff', path: item.path || 'change.txt', oldText: before, newText: after,
  })));
  block.append(toolbar);
  const changes = before.length + after.length <= 200000
    ? diffLines(before, after, { timeout: 100, maxEditLength: 5000 }) : null;
  if (!changes) {
    block.append(node('p', '', 'Large change — open the full diff in the editor.'));
    return block;
  }
  const table = node('table', 'diff-lines');
  table.setAttribute('aria-label', `Changes in ${item.path || 'file'}`);
  const body = node('tbody');
  let oldLine = 1;
  let newLine = 1;
  for (const change of changes) {
    const lines = change.value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const allRows = [];
    for (const line of lines) {
      const row = node('tr', change.added ? 'added' : change.removed ? 'removed' : 'context');
      row.dataset.oldLine = change.added ? '' : String(oldLine);
      row.dataset.newLine = change.removed ? '' : String(newLine);
      row.append(node('td', 'line-number', change.added ? '' : oldLine++),
        node('td', 'line-number', change.removed ? '' : newLine++),
        node('td', 'diff-sign', change.added ? '+' : change.removed ? '−' : ' '), node('td', 'diff-code', line));
      allRows.push(row);
    }
    if (!change.added && !change.removed && allRows.length > 12) {
      const gap = node('tr', 'diff-gap');
      const cell = node('td');
      cell.colSpan = 4;
      cell.append(button(`Show ${allRows.length - 6} unchanged lines`, () => {
        gap.replaceWith(...allRows.slice(3, -3));
      }));
      gap.append(cell);
      body.append(...allRows.slice(0, 3), gap, ...allRows.slice(-3));
    } else body.append(...allRows);
  }
  table.append(body);
  const scroll = node('div', 'result-scroll');
  scroll.append(table);
  block.append(scroll);
  if (before && !before.endsWith('\n') || after && !after.endsWith('\n')) {
    block.append(node('small', '', 'No newline at end of ' + [before && !before.endsWith('\n') ? 'old file' : '', after && !after.endsWith('\n') ? 'new file' : ''].filter(Boolean).join(' and ')));
  }
  return block;
}

function image(item) {
  const block = node('figure', 'tool-image');
  const picture = node('img');
  picture.src = `data:${item.mimeType};base64,${item.data}`;
  picture.alt = item.name || 'Tool image';
  block.append(button('Zoom image', () => {
    const zoomed = block.classList.toggle('zoomed');
    block.querySelector('button').textContent = zoomed ? 'Fit image' : 'Zoom image';
  }));
  const scroll = node('div', 'result-scroll');
  scroll.append(picture);
  block.append(scroll);
  return block;
}

function data(value, depth = 0) {
  if (value === null || typeof value !== 'object') return node('span', '', stringify(value));
  if (depth >= 8) return text(stringify(value));
  if (Array.isArray(value) && value.length && value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    const columns = [...new Set(value.flatMap(Object.keys))];
    if (columns.length <= 20 && columns.every((key) => value.every((row) => row[key] === null || typeof row[key] !== 'object'))) {
      const scroll = node('div', 'result-scroll');
      const table = node('table', 'result-table');
      const head = node('thead');
      const header = node('tr');
      const body = node('tbody');
      const fill = (rows) => body.replaceChildren(...rows.slice(0, 1000).map((row) => {
        const tr = node('tr');
        tr.append(...columns.map((key) => node('td', '', row[key] == null ? '' : String(row[key]))));
        return tr;
      }));
      for (const key of columns) {
        const th = node('th');
        let ascending = false;
        th.append(button(key, () => {
          ascending = !ascending;
          for (const other of header.children) other.removeAttribute('aria-sort');
          th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
          fill([...value].sort((a, b) => (ascending ? 1 : -1) * (typeof a[key] === 'number' && typeof b[key] === 'number'
            ? a[key] - b[key] : String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true }))));
        }));
        header.append(th);
      }
      head.append(header);
      table.append(head, body);
      fill(value);
      scroll.append(table);
      if (value.length > 1000) scroll.append(node('p', '', `Showing 1000 of ${value.length} rows`));
      return scroll;
    }
  }
  const tree = node('div', 'result-tree');
  for (const [key, child] of Object.entries(value).slice(0, 1000)) {
    const entry = node('details');
    entry.append(node('summary', '', `${key}: ${child && typeof child === 'object' ? Array.isArray(child) ? `[${child.length}]` : '{…}' : stringify(child)}`));
    if (child && typeof child === 'object') entry.append(data(child, depth + 1));
    tree.append(entry);
  }
  return tree;
}

function locations(value, post) {
  const list = node('div', 'result-locations');
  const groups = new Map();
  for (const item of value.items) {
    if (!item || typeof item.path !== 'string') continue;
    if (!groups.has(item.path)) {
      const group = node('section');
      group.append(node('strong', '', item.path));
      groups.set(item.path, group);
      list.append(group);
    }
    const line = Number(item.line) || 1;
    const row = node('div', 'result-location');
    row.append(button(`${line}${item.severity ? ` · ${item.severity}` : ''}`, () => post({ type: 'openFile', path: item.path, line, column: Number(item.column) || 1 })),
      node('pre', '', item.message || item.text || ''));
    groups.get(item.path).append(row);
  }
  return list;
}

function render(root, update, post) {
  const result = document.createDocumentFragment();
  for (const item of Array.isArray(update.content) ? update.content : []) {
    if (!item) continue;
    const content = item.type === 'content' ? item.content : item;
    if (item.type === 'diff' && typeof item.newText === 'string' && (item.oldText == null || typeof item.oldText === 'string')) {
      result.append(diff(item, post));
    } else if (content?.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(content.mimeType) && typeof content.data === 'string') {
      result.append(image(content));
    } else if (content?.type === 'text') result.append(text(content.text));
    else if (content?.type === 'resource' && typeof content.resource?.text === 'string') result.append(text(content.resource.text));
    else result.append(text(stringify(content)));
  }
  if (!result.childNodes.length && update.rawOutput !== undefined) {
    const value = update.rawOutput;
    if (value && ['search', 'diagnostics'].includes(value.type) && Array.isArray(value.items)) result.append(locations(value, post));
    else result.append(value && typeof value === 'object' ? data(value) : text(value));
  }
  root.replaceChildren(result);
  return root.childNodes.length > 0;
}

module.exports = { render };

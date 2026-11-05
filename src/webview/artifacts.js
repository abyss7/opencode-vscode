'use strict';

const { parseArtifact } = require('../artifact-contract');
const { chart, colors } = require('./charts');
const tools = require('./tool-results');
const selection = require('./selection');

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label, action) {
  const el = node('button', '', label);
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}

function create({ root, toggle, renderMarkdown, hydrate, post, save, onAsk, preferences = {} }) {
  if (!root) return { ingest() {}, reset() {}, offer() {} };
  const objects = new Map();
  let selected = preferences.id;
  let version = preferences.version;
  let opened = preferences.open === true;
  let sourceMode = false;
  let interaction;
  const toolbar = node('div', 'artifact-toolbar');
  const picker = node('select');
  picker.setAttribute('aria-label', 'Artifact');
  const versions = node('select');
  versions.setAttribute('aria-label', 'Artifact version');
  const source = button('Source', () => { sourceMode = !sourceMode; draw(); });
  const exportButton = button('Export', () => {
    const entry = current();
    if (entry) post({ type: 'exportArtifact', name: `${entry.value.id}-v${entry.value.version}.json`, content: entry.source });
  });
  const close = button('Close artifacts', () => { opened = false; sync(); toggle.focus(); });
  toolbar.append(picker, versions, source, exportButton, close);
  const links = node('div', 'artifact-links');
  const content = node('div', 'artifact-content');
  root.append(toolbar, links, content);
  const current = () => objects.get(selected)?.get(version);
  const persist = () => save({ id: selected, version, open: opened });
  function sync() {
    root.hidden = !opened || objects.size === 0;
    toggle.hidden = objects.size === 0;
    toggle.textContent = 'Artifacts';
    toggle.setAttribute('aria-expanded', String(!root.hidden));
    persist();
  }
  function draw() {
    interaction?.dispose();
    picker.replaceChildren(...[...objects].map(([id, revisions]) => {
      const option = node('option', '', [...revisions.values()].at(-1).value.title);
      option.value = id;
      return option;
    }));
    picker.value = selected;
    const revisions = objects.get(selected);
    versions.replaceChildren(...[...(revisions?.keys() || [])].sort((a, b) => a - b).map((v) => {
      const option = node('option', '', `v${v}`);
      option.value = String(v);
      return option;
    }));
    versions.value = String(version);
    content.replaceChildren();
    links.replaceChildren();
    if (!opened) { sync(); return; }
    const entry = current();
    if (!entry) { sync(); return; }
    const value = entry.value;
    source.textContent = sourceMode ? 'Preview' : 'Source';
    source.setAttribute('aria-pressed', String(sourceMode));
    links.append(button('Go to message', () => { entry.reference.scrollIntoView({ block: 'center' }); entry.reference.querySelector('button')?.focus(); }));
    if (value.source?.path) links.append(button('Open source file', () => post({ type: 'openFile', path: value.source.path, line: Number(value.source.line) || 1 })));
    if (sourceMode) content.append(node('pre', 'artifact-source', entry.source));
    else if (value.kind === 'markdown' || value.kind === 'mermaid') {
      content.classList.add('md');
      // Choose a fence longer than any in the source.
      const fence = '`'.repeat(Math.max(3, ...(value.content.match(/`+/g) || []).map((s) => s.length + 1)));
      content.innerHTML = renderMarkdown(value.kind === 'mermaid' ? `${fence}mermaid\n${value.content}\n${fence}` : value.content);
      for (const nested of content.querySelectorAll('.artifact-reference pre')) nested.hidden = false;
      hydrate(content);
    } else if (value.kind === 'chart') {
      content.append(chart(value));
      const legend = node('ul', 'chart-legend');
      value.series.forEach((series, i) => {
        const item = node('li', '', series.name);
        item.style.borderLeft = `4px solid ${colors[i % colors.length]}`;
        legend.append(item);
      });
      content.append(legend);
      const details = node('details', 'chart-data');
      details.append(node('summary', '', 'Data and units'));
      const table = node('div');
      tools.render(table, { rawOutput: value.series.flatMap((series) => series.values.map((p) => ({ series: series.name, x: p.x, y: p.y, unit: value.unit }))) }, post);
      details.append(table);
      content.append(details);
    } else if (value.kind === 'table') tools.render(content, { rawOutput: value.data }, post);
    else if (value.kind === 'diff') tools.render(content, { content: [{ ...value, type: 'diff' }] }, post);
    else if (value.kind === 'image') {
      const match = value.dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
      tools.render(content, { content: [{ type: 'image', mimeType: match[1], data: match[2], name: value.title }] }, post);
    }
    if (!sourceMode && onAsk) interaction = selection.attach(content, value, onAsk);
    sync();
  }
  picker.addEventListener('change', () => { selected = picker.value; version = Math.max(...objects.get(selected).keys()); draw(); });
  versions.addEventListener('change', () => { version = Number(versions.value); draw(); });
  toggle.addEventListener('click', () => { opened = !opened; draw(); });
  function ingest(container) {
    for (const reference of container.querySelectorAll('.artifact-reference:not([data-ingested])')) {
      reference.dataset.ingested = 'true';
      const raw = reference.querySelector('pre').textContent;
      try {
        const value = parseArtifact(raw);
        let revisions = objects.get(value.id);
        if (!revisions) { revisions = new Map(); objects.set(value.id, revisions); }
        const previous = revisions.get(value.version);
        if (previous && previous.source !== raw) throw new Error('This version already exists; use a new version number');
        const wasLatest = selected === value.id && version === Math.max(...revisions.keys());
        revisions.set(value.version, { value, source: raw, reference });
        reference.replaceChildren(button(`${value.title} · v${value.version} · ${value.kind}`, () => {
          selected = value.id; version = value.version; opened = true; sourceMode = false; draw();
        }));
        if (!selected || wasLatest && value.version > version) { selected = value.id; version = value.version; }
      } catch (error) {
        reference.prepend(node('p', 'visual-error', `Artifact: ${error.message}`));
        reference.querySelector('pre').hidden = false;
      }
    }
    draw();
  }
  return {
    ingest,
    offer(value, container) {
      const reference = node('section', 'artifact-reference artifact-offer');
      const raw = node('pre', '', JSON.stringify({ schema: 1, version: 1, ...value }));
      raw.hidden = true;
      reference.append(raw);
      container.append(reference);
      ingest(container);
      const inspect = reference.querySelector('button');
      if (inspect) inspect.textContent = `Inspect ${value.title}`;
    },
    reset() { interaction?.dispose(); objects.clear(); content.replaceChildren(); root.hidden = true; toggle.hidden = true; },
  };
}

module.exports = { create };

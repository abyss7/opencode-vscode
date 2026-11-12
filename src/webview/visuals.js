'use strict';

const { findTheme } = require('./diagram-themes');
let library;
let observer;
let lastTheme;

function theme() {
  const style = getComputedStyle(document.body);
  return { font: style.fontFamily };
}

function diagrams() {
  if (!library) library = new Promise((resolve, reject) => {
    const entry = document.getElementById('chat-script');
    const script = document.createElement('script');
    script.src = entry.dataset.diagramsUri;
    script.nonce = entry.nonce;
    script.onload = () => resolve(window.OpenCodeDiagrams);
    script.onerror = () => { library = null; script.remove(); reject(new Error('Diagram renderer could not be loaded.')); };
    document.head.appendChild(script);
  });
  return library;
}

function scaleDiagram(block, action) {
  const svg = block.querySelector('.diagram-preview svg');
  if (!svg) return;
  const width = svg.viewBox.baseVal.width;
  if (!width) return;
  let scale = Number(block.dataset.scale || 1);
  if (action === 'in') scale = Math.min(3, scale * 1.25);
  if (action === 'out') scale = Math.max(0.25, scale / 1.25);
  if (action === 'fit') scale = Math.max(0.1, Math.min(1, (block.querySelector('.diagram-preview').clientWidth - 32) / width));
  block.dataset.scale = String(scale);
  svg.style.width = `${width * scale}px`;
  svg.style.maxWidth = 'none';
}

async function renderDiagram(block, onLayout) {
  const revision = Number(block.dataset.revision || 0) + 1;
  block.dataset.revision = String(revision);
  block.dataset.rendered = 'pending';
  const preview = block.querySelector('.diagram-preview');
  const source = block.querySelector('.visual-source-panel code').textContent;
  const selected = findTheme(block.querySelector('.diagram-theme').value);
  try {
    if (source.length > 30000) throw new Error('Diagram is too large to preview.');
    const renderer = await diagrams();
    const svg = await renderer.render(source, { ...theme(), theme: selected.id });
    if (!block.isConnected || Number(block.dataset.revision) !== revision) return;
    preview.dataset.theme = selected.id;
    preview.dataset.appearance = selected.dark ? 'dark' : 'light';
    preview.innerHTML = svg;
    scaleDiagram(block);
    block.dataset.rendered = 'ready';
  } catch (error) {
    if (!block.isConnected || Number(block.dataset.revision) !== revision) return;
    preview.replaceChildren();
    const message = document.createElement('p');
    message.className = 'visual-error';
    message.textContent = 'Unable to preview this diagram. Its source is available below.';
    message.title = String(error.message || error).slice(0, 1000);
    preview.appendChild(message);
    block.querySelector('.visual-source-panel').hidden = false;
    block.querySelector('.visual-source-toggle').hidden = true;
    block.dataset.rendered = 'error';
  }
  if (onLayout) onLayout();
}

function hydrate(root, onLayout) {
  if (!root.querySelectorAll || typeof MutationObserver === 'undefined') return;
  for (const formula of root.querySelectorAll('.math-block')) {
    const annotation = formula.querySelector('annotation');
    const source = formula.querySelector('.math-source code');
    if (annotation && source) source.textContent = annotation.textContent;
    else formula.querySelector('.math-source').hidden = true;
  }
  for (const formula of root.querySelectorAll('.katex')) {
    const annotation = formula.querySelector('annotation');
    if (annotation) formula.title = annotation.textContent;
  }
  for (const block of root.querySelectorAll('.diagram:not([data-rendered])')) {
    block.querySelector('.diagram-theme').addEventListener('change', () => { void renderDiagram(block, onLayout); });
    for (const button of block.querySelectorAll('[data-diagram-zoom]')) {
      button.addEventListener('click', () => scaleDiagram(block, button.dataset.diagramZoom));
    }
    block.querySelector('.visual-source-toggle').addEventListener('click', (event) => {
      const source = block.querySelector('.visual-source-panel');
      source.hidden = !source.hidden;
      block.querySelector('.diagram-preview').hidden = !source.hidden;
      event.currentTarget.textContent = source.hidden ? 'Source' : 'Preview';
      event.currentTarget.setAttribute('aria-pressed', String(!source.hidden));
    });
    void renderDiagram(block, onLayout);
  }
  if (!observer) {
    lastTheme = JSON.stringify(theme());
    observer = new MutationObserver(() => {
      const next = JSON.stringify(theme());
      if (lastTheme === next) return;
      lastTheme = next;
      for (const block of document.querySelectorAll('.diagram[data-rendered="ready"]')) void renderDiagram(block);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  }
}

module.exports = { hydrate };

'use strict';

function button(text, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  el.addEventListener('click', action);
  return el;
}

function attach(root, artifact, onAsk) {
  const toolbar = document.createElement('div');
  toolbar.className = 'selection-toolbar';
  const status = document.createElement('span');
  status.setAttribute('aria-live', 'polite');
  let selection = { type: 'artifact' };
  let anchor;
  const artifactData = { ...artifact };
  delete artifactData.dataUrl;
  const ask = button('Ask about selection', () => {
    const images = selection.type === 'image-region' ? cropImages() : [];
    const source = { ...artifactData };
    // Selected rows already carry exact text and coordinates.
    if (selection.type === 'diff-lines') { delete source.oldText; delete source.newText; }
    onAsk({ artifact: source, selection: { ...selection, ...(annotation?.value ? { annotation: annotation.value } : {}) } }, images);
  });
  toolbar.append(status, ask);
  root.prepend(toolbar);
  let annotation;
  let image;
  let region;
  let overlay;
  let inputs;
  let stage;
  const clearHighlights = () => root.querySelectorAll('.element-selected').forEach((el) => el.classList.remove('element-selected'));
  const mark = (target, value, description) => {
    clearHighlights();
    target?.classList.add('element-selected');
    selection = value;
    status.textContent = description;
  };
  status.textContent = artifact.kind === 'mermaid' ? 'Select a diagram node' : artifact.kind === 'diff' ? 'Select lines; Shift extends the range' : artifact.kind === 'chart' ? 'Select a series' : 'Whole artifact';
  const activate = (event) => {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const target = event.target.closest?.('[data-series], .diagram-preview .node, .diff-lines tr[data-old-line]');
    if (!target || !root.contains(target)) return;
    event.preventDefault();
    if (target.dataset.series) {
      const series = artifact.series.find((item) => item.name === target.dataset.series);
      mark(target, { type: 'chart-series', name: series.name, values: series.values, unit: artifact.unit }, `Series: ${series.name}`);
    } else if (target.matches('.node')) {
      const label = target.textContent.trim();
      mark(target, { type: 'diagram-node', id: target.id, label }, `Node: ${label}`);
    } else {
      const rows = [...root.querySelectorAll('.diff-lines tr[data-old-line]')];
      const index = rows.indexOf(target);
      if (!event.shiftKey || anchor == null) anchor = index;
      const selected = rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1);
      mark(null, { type: 'diff-lines', path: artifact.path, lines: selected.map((row) => ({
        oldLine: Number(row.dataset.oldLine) || null, newLine: Number(row.dataset.newLine) || null,
        change: row.classList.contains('added') ? 'added' : row.classList.contains('removed') ? 'removed' : 'context',
        text: row.querySelector('.diff-code').textContent,
      })) }, `${selected.length} diff lines`);
      selected.forEach((row) => row.classList.add('element-selected'));
    }
  };
  root.addEventListener('click', activate);
  root.addEventListener('keydown', activate);
  const accessible = () => {
    for (const target of root.querySelectorAll('.diagram-preview .node, .diff-lines tr[data-old-line]')) {
      target.setAttribute('tabindex', '0');
      target.setAttribute('role', 'button');
      target.setAttribute('aria-label', target.matches('.node') ? `Select node ${target.textContent.trim()}` : `Select diff line ${target.dataset.newLine || target.dataset.oldLine}`);
    }
  };
  const observer = new MutationObserver(accessible);
  observer.observe(root, { childList: true, subtree: true });
  accessible();

  function updateRegion(next) {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (!w || !h) return;
    region = { x: Math.max(0, Math.min(w - 1, Math.round(next.x))), y: Math.max(0, Math.min(h - 1, Math.round(next.y))) };
    region.width = Math.max(1, Math.min(w - region.x, Math.round(next.width)));
    region.height = Math.max(1, Math.min(h - region.y, Math.round(next.height)));
    for (const [key, input] of Object.entries(inputs)) input.value = String(region[key]);
    Object.assign(overlay.style, { left: `${region.x / w * 100}%`, top: `${region.y / h * 100}%`, width: `${region.width / w * 100}%`, height: `${region.height / h * 100}%` });
    selection = { type: 'image-region', ...region, imageWidth: w, imageHeight: h,
      normalized: { x: region.x / w, y: region.y / h, width: region.width / w, height: region.height / h } };
    status.textContent = `Region: ${region.x}, ${region.y} · ${region.width} × ${region.height}`;
  }
  function cropImages() {
    if (!image?.naturalWidth || !region) return [];
    const make = (name, width, height, draw) => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      draw(ctx);
      const dataUrl = canvas.toDataURL('image/png');
      return { name, mimeType: 'image/png', data: dataUrl.split(',')[1], dataUrl };
    };
    return [
      make(`${artifact.id}-crop.png`, region.width, region.height, (ctx) => ctx.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)),
      make(`${artifact.id}-annotated.png`, image.naturalWidth, image.naturalHeight, (ctx) => {
        ctx.drawImage(image, 0, 0);
        ctx.strokeStyle = '#ff3050';
        ctx.lineWidth = Math.max(2, image.naturalWidth / 300);
        ctx.strokeRect(region.x, region.y, region.width, region.height);
      }),
    ];
  }
  if (artifact.kind === 'image') {
    image = root.querySelector('.tool-image img');
    if (image) {
      const controls = document.createElement('div');
      controls.className = 'region-controls';
      inputs = {};
      for (const key of ['x', 'y', 'width', 'height']) {
        const label = document.createElement('label');
        label.textContent = key;
        const input = document.createElement('input');
        input.type = 'number';
        input.setAttribute('aria-label', `Region ${key}`);
        input.addEventListener('change', () => updateRegion({ ...region, [key]: Number(input.value) || 0 }));
        inputs[key] = input;
        label.append(input);
        controls.append(label);
      }
      annotation = document.createElement('input');
      annotation.type = 'text';
      annotation.placeholder = 'Annotation (optional)';
      annotation.setAttribute('aria-label', 'Image annotation');
      controls.append(annotation);
      toolbar.after(controls);
      stage = document.createElement('div');
      stage.className = 'image-selection-stage';
      image.replaceWith(stage);
      stage.append(image);
      overlay = document.createElement('div');
      overlay.className = 'image-region';
      stage.append(overlay);
      image.draggable = false;
      const init = () => updateRegion({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight });
      if (image.complete) init();
      else image.addEventListener('load', init, { once: true });
      let start;
      const point = (event) => {
        const box = image.getBoundingClientRect();
        return { x: (event.clientX - box.x) / box.width * image.naturalWidth, y: (event.clientY - box.y) / box.height * image.naturalHeight };
      };
      stage.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); start = point(event); stage.setPointerCapture(event.pointerId);
      });
      stage.addEventListener('pointermove', (event) => {
        if (!start) return;
        const end = point(event);
        updateRegion({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
      });
      stage.addEventListener('pointerup', () => { start = null; });
      stage.addEventListener('pointercancel', () => { start = null; });
    }
  }
  return { dispose() { observer.disconnect(); root.removeEventListener('click', activate); root.removeEventListener('keydown', activate); } };
}

module.exports = { attach };

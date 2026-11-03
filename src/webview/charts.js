'use strict';

const colors = ['#438bd1', '#dd8730', '#3fa777', '#bb6fd0', '#d75b71'];
function svgNode(tag, attrs = {}, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

function chart(value) {
  const svg = svgNode('svg', { viewBox: '0 0 640 360', role: 'img', 'aria-label': value.title, class: 'artifact-chart' });
  svg.append(svgNode('title', {}, value.title), svgNode('desc', {}, `${value.xLabel}; ${value.yLabel} (${value.unit}). Exact values are in the data table.`));
  const points = value.series.flatMap((series) => series.values);
  let xMin = Math.min(...points.map((p) => p.x));
  let xMax = Math.max(...points.map((p) => p.x));
  let yMin = Math.min(0, ...points.map((p) => p.y));
  let yMax = Math.max(0, ...points.map((p) => p.y));
  if (xMin === xMax) { xMin -= 1; xMax += 1; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const xs = (x) => 70 + ((x - xMin) / (xMax - xMin)) * 530;
  const ys = (y) => 300 - ((y - yMin) / (yMax - yMin)) * 260;
  const label = (x, y, text, anchor = 'middle') => svgNode('text', { x, y, fill: 'currentColor', 'text-anchor': anchor, 'font-size': 16 }, text);
  for (let i = 0; i <= 4; i++) {
    const y = yMin + (yMax - yMin) * i / 4;
    svg.append(svgNode('line', { x1: 70, x2: 600, y1: ys(y), y2: ys(y), stroke: 'currentColor', opacity: 0.15 }), label(62, ys(y) + 4, Number(y.toPrecision(4)), 'end'));
    const x = xMin + (xMax - xMin) * i / 4;
    svg.append(label(xs(x), 320, Number(x.toPrecision(4))));
  }
  svg.append(label(335, 350, value.xLabel), label(70, 20, `${value.yLabel} (${value.unit || 'unitless'})`, 'start'));
  const distinctX = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
  const spacing = distinctX.length > 1 ? Math.min(...distinctX.slice(1).map((x, i) => xs(x) - xs(distinctX[i]))) : 80;
  const width = Math.max(1, Math.min(40, spacing * 0.7 / value.series.length));
  value.series.forEach((series, index) => {
    const group = svgNode('g', { 'data-series': series.name, tabindex: 0, role: 'button', 'aria-label': `${series.name}: select series` });
    const color = colors[index % colors.length];
    const sorted = [...series.values].sort((a, b) => a.x - b.x);
    if (value.chart === 'line') group.append(svgNode('polyline', {
      points: sorted.map((p) => `${xs(p.x)},${ys(p.y)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-dasharray': index >= colors.length ? '6 3' : 'none',
    }));
    for (const p of sorted) {
      const point = value.chart === 'line'
        ? svgNode('circle', { cx: xs(p.x), cy: ys(p.y), r: 4, fill: color })
        : svgNode('rect', { x: xs(p.x) + (index - value.series.length / 2) * width, y: Math.min(ys(p.y), ys(0)), width, height: Math.max(1, Math.abs(ys(p.y) - ys(0))), fill: color });
      point.append(svgNode('title', {}, `${series.name}: ${p.x}, ${p.y} ${value.unit}`));
      group.append(point);
    }
    svg.append(group);
  });
  return svg;
}

module.exports = { chart, colors };

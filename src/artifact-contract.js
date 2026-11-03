'use strict';

// Versioned, declarative presentation data. No executable HTML or scripts.
function parseArtifact(source) {
  if (source.length > 2000000) throw new Error('Artifact exceeds 2 MB');
  const value = JSON.parse(source);
  if (!value || value.schema !== 1 || typeof value.id !== 'string' || !/^[\w.-]{1,100}$/.test(value.id) ||
      !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.title !== 'string') {
    throw new Error('Expected schema:1, id, positive version and title');
  }
  switch (value.kind) {
    case 'markdown':
    case 'mermaid':
      if (typeof value.content !== 'string') throw new Error('Expected text content');
      break;
    case 'table':
      if (!Array.isArray(value.data)) throw new Error('Expected a data array');
      break;
    case 'diff':
      if (typeof value.newText !== 'string' || (value.oldText != null && typeof value.oldText !== 'string')) throw new Error('Expected oldText/newText');
      break;
    case 'image':
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(value.dataUrl || '')) throw new Error('Expected an embedded raster image');
      break;
    case 'chart': {
      if (!['line', 'bar'].includes(value.chart) || typeof value.xLabel !== 'string' || typeof value.yLabel !== 'string' || typeof value.unit !== 'string' ||
          !Array.isArray(value.series) || !value.series.length || value.series.length > 20) throw new Error('Expected line/bar, axis labels, unit and series');
      let count = 0;
      for (const series of value.series) {
        if (typeof series.name !== 'string' || !Array.isArray(series.values) || !series.values.length ||
            !series.values.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('Expected named series of finite {x,y} values');
        count += series.values.length;
      }
      if (count > 5000) throw new Error('Chart exceeds 5000 points');
      break;
    }
    default: throw new Error('Unknown artifact kind');
  }
  return value;
}

module.exports = { parseArtifact };

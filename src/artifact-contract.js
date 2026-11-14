'use strict';

// Versioned, declarative presentation data. No executable HTML or scripts.
const PLAN_STATUSES = new Set(['todo', 'doing', 'done', 'skipped']);

function parseArtifact(source) {
  if (source.length > 16000000) throw new Error('Artifact exceeds 16 MB');
  const value = JSON.parse(source);
  if (source.length > 2000000 && value?.kind !== 'image') throw new Error('Artifact exceeds 2 MB');
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
    case 'plan': {
      const ids = new Set();
      const id = (value_, label) => {
        if (typeof value_ !== 'string' || !/^[\w.-]{1,60}$/.test(value_)) throw new Error(`Expected a ${label} id`);
        if (ids.has(value_)) throw new Error(`Duplicate ${label} id ${value_}`);
        ids.add(value_);
      };
      if (!Array.isArray(value.phases) || !value.phases.length || value.phases.length > 50) {
        throw new Error('Expected 1..50 phases');
      }
      for (const phase of value.phases) {
        if (!phase || typeof phase !== 'object') throw new Error('Expected phase objects');
        id(phase.id, 'phase');
        if (typeof phase.title !== 'string' || !phase.title.trim()) throw new Error('Expected a phase title');
        if (!Array.isArray(phase.tasks) || !phase.tasks.length || phase.tasks.length > 100) {
          throw new Error('Expected 1..100 tasks per phase');
        }
        for (const task of phase.tasks) {
          if (!task || typeof task !== 'object') throw new Error('Expected task objects');
          id(task.id, 'task');
          if (typeof task.title !== 'string' || !task.title.trim()) throw new Error('Expected a task title');
          if (!PLAN_STATUSES.has(task.status)) throw new Error(`Expected a task status ${[...PLAN_STATUSES].join('|')}`);
          if (task.note != null && typeof task.note !== 'string') throw new Error('Expected an optional string note');
        }
      }
      break;
    }
    default: throw new Error('Unknown artifact kind');
  }
  return value;
}

module.exports = { parseArtifact, PLAN_STATUSES };

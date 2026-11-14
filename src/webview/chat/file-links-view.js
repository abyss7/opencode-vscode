'use strict';

/**
 * @file Layer 2 View: File reference tokenization, host existence verification,
 * and workspace delegated click handling (code copy, file links, external links).
 *
 * Strictly DOM-only — never touches scroll state.
 */

const { escapeHtml } = require('./format');

const FILE_EXTENSIONS =
  'js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|mdx|css|scss|sass|less|html|htm|' +
  'xml|ya?ml|toml|ini|cfg|conf|txt|sh|bash|zsh|py|go|rs|c|cc|cpp|cxx|' +
  'h|hh|hpp|hxx|java|kt|kts|rb|php|swift|m|mm|lua|pl|proto|sql|gn|gni|' +
  'cmake|gradle|lock|svg';

const FILE_REF = new RegExp(
  '(^|[^\\w/.:@-])' +
    '((?:\\.{1,2}/|/|~/)?(?:[\\w.@+-]+/)*[\\w.@+-]+\\.(?:' +
    FILE_EXTENSIONS +
    '))' +
    '(?:#L(\\d+)|:(\\d+))?(?::(\\d+))?' +
    '(?![\\w/])',
  'g'
);

const FILE_TARGET = new RegExp(
  '^(?:\\.{1,2}/|/|~/)?(?:[\\w.@+-]+/)*[\\w.@+-]+\\.(?:' +
    FILE_EXTENSIONS +
    ')(?:#L\\d+(?:C\\d+)?|:\\d+(?::\\d+)?)?$'
);

function fileLinkParts(value) {
  const raw = String(value || '').trim();
  if (!FILE_TARGET.test(raw)) return null;

  let file = raw;
  let line = '';
  let column = '';
  const hash = file.match(/^(.*?)#L(\d+)(?:C(\d+))?$/i);
  if (hash) {
    file = hash[1];
    line = hash[2];
    column = hash[3] || '';
  } else {
    const colon = file.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (colon) {
      file = colon[1];
      line = colon[2];
      column = colon[3] || '';
    }
  }
  return { file, line, column };
}

function fileToken(parts, label) {
  let attributes = ' data-file="' + parts.file + '"';
  if (parts.line) attributes += ' data-line="' + parts.line + '"';
  if (parts.column) attributes += ' data-column="' + parts.column + '"';
  return '<span class="file-ref"' + attributes + '>' + label + '</span>';
}

function renderFileText(value) {
  return escapeHtml(value).replace(
    FILE_REF,
    (match, prefix, file, hashLine, colonLine, column) => {
      const line = hashLine || colonLine || '';
      const label =
        file +
        (line ? (hashLine ? '#L' + line : ':' + line) : '') +
        (column ? ':' + column : '');
      return prefix + fileToken({ file, line, column: column || '' }, label);
    }
  );
}

function fileRefKey(node) {
  return [
    node.dataset.file || '',
    node.dataset.line || '',
    node.dataset.column || '',
  ].join('\u0000');
}

function createFileLinksView({ store, messagesEl, workspaceEl, richText, postMessage, onCopyError }) {
  let checkTimer = null;
  const rootEl = workspaceEl || messagesEl;

  function renderMarkdown(source) {
    return richText.render(source, {
      text: renderFileText,
      file: (target, label) => {
        const parts = fileLinkParts(escapeHtml(target));
        return parts ? fileToken(parts, label) : null;
      },
    });
  }

  function applyFileChecks() {
    if (!messagesEl || typeof messagesEl.querySelectorAll !== 'function') return;
    const pending = [];
    for (const node of rootEl.querySelectorAll('.file-ref')) {
      if (!node.dataset || !node.dataset.file) continue;
      const key = fileRefKey(node);
      const exists = store.state.fileChecks.get(key);
      if (exists === true) {
        node.classList.add('file-link');
      } else if (exists === false) {
        node.classList.remove('file-link');
      } else if (!store.state.fileCheckPending.has(key) && pending.length < 100) {
        store.state.fileCheckPending.add(key);
        pending.push({
          key,
          path: node.dataset.file,
          line: node.dataset.line || null,
          column: node.dataset.column || null,
        });
      }
    }
    if (pending.length > 0) {
      postMessage({ type: 'checkFiles', files: pending });
    }
  }

  function scheduleFileChecks() {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = null;
      applyFileChecks();
    }, 120);
  }

  rootEl?.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copy = target.closest('.code-copy');
    if (copy) {
      try {
        await navigator.clipboard.writeText(
          copy.closest('.code-block').querySelector('pre code').textContent
        );
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      } catch {
        onCopyError?.('Could not copy code to the clipboard.');
      }
      return;
    }

    const fileLink = target.closest('.file-link[data-file]');
    if (fileLink) {
      event.preventDefault();
      const payload = { type: 'openFile', path: fileLink.dataset.file };
      if (fileLink.dataset.line) payload.line = Number(fileLink.dataset.line);
      if (fileLink.dataset.column) payload.column = Number(fileLink.dataset.column);
      postMessage(payload);
      return;
    }

    const link = target.closest('a[data-href]');
    if (!link) return;
    event.preventDefault();
    postMessage({ type: 'openExternal', url: link.getAttribute('data-href') });
  });

  return {
    renderMarkdown,
    applyFileChecks,
    scheduleFileChecks,
  };
}

module.exports = { createFileLinksView, fileLinkParts, renderFileText };

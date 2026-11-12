'use strict';

const mermaid = require('mermaid').default;
const { findTheme } = require('./diagram-themes');
let sequence = 0;
let queue = Promise.resolve();

function render(source, options = {}) {
  const task = queue.then(async () => {
    const theme = findTheme(options.theme);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: true,
      maxTextSize: 30000,
      maxEdges: 500,
      // ELK is bundled with Mermaid 12; no extra loader or network request.
      layout: 'elk',
      theme: theme.id,
      look: theme.look,
      flowchart: { wrappingWidth: 280 },
      // Formatting only: labels cannot load resources or inject CSS/links.
      dompurifyConfig: {
        ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'code', 'pre', 'br', 'p', 'span', 'div', 'sub', 'sup', 'ul', 'ol', 'li'],
        ALLOWED_ATTR: [],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'dompurifyConfig', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS'],
      themeVariables: {
        fontFamily: options.font,
        fontSize: '14px',
      },
    });
    const result = await mermaid.render(`diagram-${++sequence}`, source);
    return result.svg;
  });
  queue = task.catch(() => {});
  return task;
}

module.exports = { render };

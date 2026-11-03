'use strict';

const mermaid = require('mermaid').default;
let sequence = 0;
let queue = Promise.resolve();

function render(source, theme) {
  const task = queue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      maxTextSize: 30000,
      maxEdges: 500,
      theme: 'base',
      themeVariables: {
        darkMode: theme.dark,
        background: theme.background,
        primaryColor: theme.background,
        primaryTextColor: theme.foreground,
        primaryBorderColor: theme.accent,
        lineColor: theme.foreground,
        secondaryColor: theme.background,
        tertiaryColor: theme.background,
        fontFamily: theme.font,
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

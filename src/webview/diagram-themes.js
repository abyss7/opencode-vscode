'use strict';

// Mermaid's built-in palettes; keep the editor theme out of diagram colors.
const themes = [
  ['dark', 'Dark'],
  ['default', 'Default'],
  ['neutral', 'Neutral'],
  ['forest', 'Forest'],
  ['neo', 'Neo'],
  ['neo-dark', 'Neo dark'],
  ['redux', 'Redux'],
  ['redux-dark', 'Redux dark'],
  ['redux-color', 'Redux color'],
  ['redux-dark-color', 'Redux dark color'],
].map(([id, label]) => ({
  id, label,
  dark: id.includes('dark'),
  look: /^(neo|redux)/.test(id) ? 'neo' : 'classic',
}));

function findTheme(id) {
  return themes.find((item) => item.id === id) || themes[0];
}

module.exports = { themes, findTheme };

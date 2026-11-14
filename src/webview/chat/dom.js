'use strict';

/**
 * @file Minimal DOM construction utilities shared across Layer 2 webview views.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

module.exports = { el };

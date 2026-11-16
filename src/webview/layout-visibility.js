'use strict';

/**
 * Skip structurally hidden subtrees BEFORE asking the browser for geometry.
 * Chromium can lay out descendants of closed <details> on a clientWidth/rect
 * read, even when every read is batched. CSS-only visibility still needs the
 * usual geometry check; the first direct summary of closed details is visible.
 */
function isLayoutHidden(node) {
  for (let child = node; child; child = child.parentElement) {
    if (child.hidden) return true;
    const parent = child.parentElement;
    if (parent?.tagName === 'DETAILS' && !parent.open &&
        child !== parent.querySelector(':scope > summary')) return true;
  }
  return false;
}

module.exports = { isLayoutHidden };

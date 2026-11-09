'use strict';

// Scroll one explicit viewport, without scrollIntoView's ancestor propagation.
function scrollToElement(container, target, { block = 'center', behavior = 'auto' } = {}) {
  if (!container || !target || !container.contains(target)) return;
  const bounds = target.getBoundingClientRect();
  const offset = bounds.top - container.getBoundingClientRect().top - container.clientTop;
  container.scrollTo({
    top: container.scrollTop + offset - (block === 'start' ? 0 : (container.clientHeight - bounds.height) / 2),
    behavior,
  });
}

module.exports = { scrollToElement };

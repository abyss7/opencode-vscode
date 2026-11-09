/* Shared by the chat bundle and the unbundled sessions sidebar. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenCodeScroll = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const viewports = new WeakMap();

  function registerViewport(container, controller) {
    viewports.set(container, controller);
    return () => viewports.delete(container);
  }

  // Never ask the browser to reveal all ancestors (scrollIntoView / focus).
  function scrollToElement(container, target, { block = 'center', behavior = 'auto' } = {}) {
    if (!container || !target || !container.contains(target)) return;
    if (behavior === 'smooth' && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) behavior = 'instant';
    const bounds = target.getBoundingClientRect();
    const offset = bounds.top - container.getBoundingClientRect().top - container.clientTop;
    let delta = offset;
    if (block === 'nearest') {
      if (offset >= 0 && offset + bounds.height <= container.clientHeight) return;
      delta = offset < 0 ? offset : offset + bounds.height - container.clientHeight;
    } else if (block === 'center') delta -= (container.clientHeight - bounds.height) / 2;
    const top = container.scrollTop + delta;
    const controller = viewports.get(container);
    if (controller) controller.navigate(top, behavior);
    else container.scrollTo({ top, behavior });
  }

  function focusWithoutScroll(target, container) {
    if (!target) return;
    target.focus({ preventScroll: true });
    if (container) scrollToElement(container, target, { block: 'nearest' });
  }

  return { scrollToElement, focusWithoutScroll, registerViewport };
});

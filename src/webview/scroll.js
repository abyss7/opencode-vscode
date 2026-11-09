'use strict';

const { scrollToElement, focusWithoutScroll, registerViewport } = require('../../media/scroll');

// One owner for follow-bottom, deliberate navigation and reading restoration.
// Native anchoring is disabled on this viewport so it cannot race our anchor.
function createTranscriptViewport(container, onChange = () => {}) {
  let following = true;
  let reading = null;
  let readingNode = null;
  let readingRoot = null;
  let expectedTop = null;
  let navigating = false;
  let settleTimer;
  let frame;
  const observed = new Set();

  function visibleAnchor() {
    const top = container.getBoundingClientRect().top;
    const root = [...container.children].find(node => {
      const bounds = node.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > top;
    });
    // Keep a paragraph/row stable even when an image above it changes size
    // inside the same message. Paths also survive streamed Markdown rerenders.
    const node = root && [...root.querySelectorAll('p, pre, summary, tr, img, .diagram-preview')].find(child => {
      const bounds = child.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > top;
    }) || root;
    const path = [];
    for (let child = node; child && child !== root; child = child.parentElement) {
      path.unshift([...child.parentElement.children].indexOf(child));
    }
    return { root, node, path };
  }

  function capture(anchor) {
    const top = container.getBoundingClientRect().top;
    if (!anchor && following) return { bottom: true, top: container.scrollTop };
    anchor ||= visibleAnchor();
    return { bottom: following, top: container.scrollTop, anchor: anchor.root?.dataset.anchorId,
      path: anchor.path, offset: anchor.node ? anchor.node.getBoundingClientRect().top - top : 0,
      rootOffset: anchor.root ? anchor.root.getBoundingClientRect().top - top : 0 };
  }

  function rememberReading() {
    if (following) { reading = null; readingNode = null; readingRoot = null; return; }
    const anchor = visibleAnchor();
    readingRoot = anchor.root;
    readingNode = anchor.node;
    reading = capture(anchor);
  }

  function write(top) {
    container.scrollTop = top;
    expectedTop = container.scrollTop;
  }

  function update() {
    if (navigating) return;
    if (following) write(container.scrollHeight);
    else if (reading) {
      const root = readingRoot?.parentElement === container ? readingRoot :
        reading.anchor && [...container.children].find(node => node.dataset.anchorId === reading.anchor);
      const candidate = root && (root.contains(readingNode) ? readingNode :
        (reading.path || []).reduce((node, index) => node?.children[index], root));
      const anchor = candidate?.getBoundingClientRect().height > 0 ? candidate : root;
      const offset = anchor === candidate ? reading.offset : reading.rootOffset ?? reading.offset;
      write(anchor ? container.scrollTop + anchor.getBoundingClientRect().top -
        container.getBoundingClientRect().top - offset : reading.top);
    }
    onChange();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; update(); });
  }

  function restore(viewport) {
    if (!viewport) return;
    navigating = false;
    clearTimeout(settleTimer);
    following = Boolean(viewport.bottom);
    reading = viewport;
    readingNode = null;
    readingRoot = null;
    update();
    rememberReading();
    onChange();
  }

  function navigate(top, behavior) {
    following = false;
    navigating = true;
    expectedTop = null;
    container.scrollTo({ top, behavior });
    settledNavigation();
  }

  function settledNavigation() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      navigating = false;
      rememberReading();
      onChange();
    }, 120);
  }

  function userIntent(event) {
    if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.type === 'wheel' && !event.deltaY) return;
    navigating = false;
    clearTimeout(settleTimer);
    expectedTop = null;
    if (event.type === 'wheel' || event.type === 'keydown') {
      // Suspend following before the browser applies an upward wheel/key action.
      // A subsequent user scroll reaching the bottom re-enables it.
      const towardBottom = event.type === 'wheel' ? event.deltaY > 0 :
        ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
      following = towardBottom && container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
    }
    rememberReading();
  }

  function scrolled() {
    if (expectedTop !== null && Math.abs(container.scrollTop - expectedTop) < 1) return;
    expectedTop = null;
    if (navigating) settledNavigation();
    else following = container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
    rememberReading();
    onChange();
  }

  const resize = new ResizeObserver(schedule);
  resize.observe(container);
  function observeContent() {
    for (const node of observed) if (node.parentElement !== container) { resize.unobserve(node); observed.delete(node); }
    for (const node of container.children) if (!observed.has(node)) { observed.add(node); resize.observe(node); }
    schedule();
  }
  const mutations = new MutationObserver(observeContent);
  mutations.observe(container, { childList: true, subtree: true, characterData: true });
  observeContent();
  container.addEventListener('scroll', scrolled, { passive: true });
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) container.addEventListener(type, userIntent, { passive: true });
  const unregister = registerViewport(container, { navigate });

  return {
    get following() { return following; },
    get navigating() { return navigating; },
    pause() { following = false; navigating = false; clearTimeout(settleTimer); rememberReading(); },
    capture, restore, update,
    bottom() { restore({ bottom: true }); },
    dispose() {
      resize.disconnect(); mutations.disconnect(); unregister();
      cancelAnimationFrame(frame); clearTimeout(settleTimer);
      container.removeEventListener('scroll', scrolled);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) container.removeEventListener(type, userIntent);
    },
  };
}

module.exports = { scrollToElement, focusWithoutScroll, createTranscriptViewport };

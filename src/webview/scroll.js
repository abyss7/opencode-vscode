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
    // inside the same message. Identity and paths also survive streamed
    // Markdown rerenders.
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

  function identity(node) {
    const text = (node?.textContent || '').trim();
    return text ? { tag: node.tagName, text: text.slice(0, 64) } : null;
  }

  // Positional paths alone mis-resolve when a structural edit inserts or
  // removes an element above the reading position inside the same root — an
  // answer outline, a permission card, streamed Markdown gaining a heading.
  // The path then lands on a neighbouring node and the viewport drifts to
  // it. Re-find the anchor by content, keeping the node nearest to where the
  // path points, before falling back to the whole root.
  function resolveAnchor(root, reading, liveNode) {
    if (liveNode && root.contains(liveNode)) return liveNode;
    let candidate = (reading.path || []).reduce((node, index) => node?.children[index], root);
    const record = reading.identity;
    if (record && (!candidate || candidate.tagName !== record.tag ||
        (candidate.textContent || '').trim().slice(0, 64) !== record.text)) {
      const matches = [...root.querySelectorAll(record.tag)]
        .filter(node => (node.textContent || '').trim().slice(0, 64) === record.text);
      if (matches.length) {
        candidate = matches.length === 1 || !candidate ? matches[0] : nearestMatch(matches, candidate);
      }
    }
    return candidate?.getBoundingClientRect().height > 0 ? candidate : root;
  }

  function nearestMatch(matches, candidate) {
    // Elements inserted above the reading position push the recorded path onto
    // an earlier node, so prefer the first match at or after the candidate.
    for (const match of matches) {
      if (candidate.compareDocumentPosition(match) & Node.DOCUMENT_POSITION_FOLLOWING) return match;
    }
    return matches[matches.length - 1];
  }

  function capture(anchor) {
    const top = container.getBoundingClientRect().top;
    if (!anchor && following) return { bottom: true, top: container.scrollTop };
    anchor ||= visibleAnchor();
    return { bottom: following, top: container.scrollTop, anchor: anchor.root?.dataset.anchorId,
      rootPath: anchor.root ? [...container.children].indexOf(anchor.root) : null,
      path: anchor.path, identity: identity(anchor.node),
      offset: anchor.node ? anchor.node.getBoundingClientRect().top - top : 0,
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
        reading.anchor && [...container.children].find(node => node.dataset.anchorId === reading.anchor) ||
        (reading.rootPath !== null && reading.rootPath !== undefined && Number.isInteger(reading.rootPath) ?
          container.children[reading.rootPath] : null);
      const candidate = root && resolveAnchor(root, reading, readingNode);
      const anchor = candidate && candidate !== root ? candidate : root;
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

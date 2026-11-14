'use strict';

/**
 * @file Transcript viewport & scroll controller (Layer 3 of the Webview architecture).
 *
 * Architectural contract:
 * 1. Single owner of `#messages.scrollTop`. No DOM renderer or state handler may
 *    write `scrollTop` directly or call `scrollIntoView`.
 * 2. Three mutually exclusive viewport modes:
 *    - `following`: glued to the bottom edge as content streams or expands.
 *    - `parked` (`!following && !navigating`): locked onto a specific visible
 *      reading anchor (`reading`). Growth, Markdown re-renders, outline
 *      insertion, and step splits/merges above or below the reader never move
 *      the viewed pixels.
 *    - `navigating`: an explicit smooth/instant jump (`scrollToElement`) is in
 *      flight until scroll events settle.
 * 3. Render transactions (`beginMutation` / `endMutation`):
 *    Suppress intermediate observer updates during multi-step DOM patches
 *    WITHOUT altering `following` or overwriting `reading`, so disclosure
 *    policies (`foldingMoves`) always see the reader's true mode.
 * 4. Settled geometry snapshot (`lastLayout`):
 *    Protects against sub-frame races where `scrollTop` changes and DOM layout
 *    mutates within the same 16ms frame before the browser dispatches its
 *    coalesced `scroll` event.
 */

const { scrollToElement, focusWithoutScroll, registerViewport } = require('../../media/scroll');

const ANCHOR_SELECTOR = 'p, pre, summary, tr, img, .diagram-preview';

function escapeAttr(value) {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : String(value).replace(/["\\]/g, '\\$&');
}

function createTranscriptViewport(container, onChange = () => {}) {
  let following = true;
  let reading = null;
  let readingNode = null;
  let readingRoot = null;
  let expectedTop = null;
  let navigating = false;
  let batchDepth = 0;
  let syncingScroll = false;
  let lastGesture = 0;
  let lastTop = container.scrollTop;
  let lastScrollHeight = container.scrollHeight;
  let lastClientHeight = container.clientHeight;
  let lastLayout = [];
  let settleTimer;
  let frame;
  const observed = new Set();

  function rootOf(node) {
    let current = node;
    while (current && current.parentElement && current.parentElement !== container) {
      current = current.parentElement;
    }
    return current?.parentElement === container ? current : null;
  }

  function computePath(root, node) {
    const path = [];
    for (let child = node; child && child !== root && child.parentElement; child = child.parentElement) {
      path.unshift([...child.parentElement.children].indexOf(child));
    }
    return path;
  }

  function identity(node) {
    const text = (node?.textContent || '').trim();
    return text ? { tag: node.tagName, text: text.slice(0, 64) } : null;
  }

  function toolIdOf(node) {
    if (!node || typeof node.closest !== 'function') return null;
    return node.closest('.tool-entry')?.dataset?.toolCallId || null;
  }

  function visibleAnchor() {
    const top = container.getBoundingClientRect().top;
    const root = [...container.children].find((node) => {
      const bounds = node.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > top;
    });
    const node = (root && [...root.querySelectorAll(ANCHOR_SELECTOR)].find((child) => {
      const bounds = child.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > top;
    })) || root;
    return { root, node, path: root && node ? computePath(root, node) : [] };
  }

  function snapshotLayout() {
    if (!container.children?.length || !(container.clientHeight > 0)) {
      lastScrollHeight = container.scrollHeight;
      lastClientHeight = container.clientHeight;
      lastLayout = [];
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    const scrollTop = container.scrollTop;
    const entries = [];
    for (const root of container.children) {
      const rootBounds = root.getBoundingClientRect();
      if (rootBounds.height <= 0) continue;
      entries.push({
        root,
        node: root,
        isRoot: true,
        docTop: rootBounds.top - containerTop + scrollTop,
        docBottom: rootBounds.bottom - containerTop + scrollTop,
      });
      for (const child of root.querySelectorAll(ANCHOR_SELECTOR)) {
        const bounds = child.getBoundingClientRect();
        if (bounds.height <= 0) continue;
        entries.push({
          root,
          node: child,
          isRoot: false,
          docTop: bounds.top - containerTop + scrollTop,
          docBottom: bounds.bottom - containerTop + scrollTop,
        });
      }
    }
    lastScrollHeight = container.scrollHeight;
    lastClientHeight = container.clientHeight;
    lastLayout = entries;
  }

  function anchorFromSnapshot(targetScrollTop) {
    const rootEntry = lastLayout.find((entry) => entry.isRoot && entry.docBottom > targetScrollTop);
    if (!rootEntry) return null;
    const nodeEntry = lastLayout.find(
      (entry) => !entry.isRoot && entry.root === rootEntry.root && entry.docBottom > targetScrollTop
    ) || rootEntry;
    const root = rootEntry.root;
    const node = nodeEntry.node;
    return {
      root,
      node,
      record: {
        bottom: false,
        top: targetScrollTop,
        anchor: root.dataset?.anchorId,
        toolCallId: toolIdOf(node),
        rootPath: [...container.children].indexOf(root),
        path: computePath(root, node),
        identity: identity(node),
        offset: nodeEntry.docTop - targetScrollTop,
        rootOffset: rootEntry.docTop - targetScrollTop,
      },
    };
  }

  function nearestMatch(matches, candidate) {
    // Elements inserted above the reading position push the recorded path onto
    // an earlier node, so prefer the first match at or after the candidate.
    for (const match of matches) {
      if (candidate.compareDocumentPosition(match) & Node.DOCUMENT_POSITION_FOLLOWING) return match;
    }
    return matches[matches.length - 1];
  }

  function resolveRoot(record, liveNode, liveRoot) {
    // If the anchored node is still connected anywhere inside the transcript
    // (even after a `.turn-steps` block split or merged around a standalone task),
    // follow its actual current root container rather than a stale half.
    if (liveNode && container.contains(liveNode) && liveNode.getBoundingClientRect().height > 0) {
      const currentRoot = rootOf(liveNode);
      if (currentRoot) return currentRoot;
    }
    if (record.toolCallId && typeof container.querySelector === 'function') {
      const entry = container.querySelector(`.tool-entry[data-tool-call-id="${escapeAttr(record.toolCallId)}"]`);
      const entryRoot = entry && rootOf(entry);
      if (entryRoot && entryRoot.getBoundingClientRect().height > 0) return entryRoot;
    }
    if (liveRoot?.parentElement === container && liveRoot.getBoundingClientRect().height > 0) {
      return liveRoot;
    }
    if (record.anchor) {
      const byId = [...container.children].find((node) => node.dataset?.anchorId === record.anchor);
      if (byId) return byId;
    }
    if (Number.isInteger(record.rootPath)) {
      return container.children[record.rootPath] || null;
    }
    return null;
  }

  /**
   * Resolve the anchor a captured viewport refers to. Only a node whose content
   * confirms the captured identity may receive the paragraph offset; anything
   * else falls back to `root` with `rootOffset` so wholesale replacement of a
   * message never teleports the viewport.
   */
  function resolveAnchor(root, record, liveNode) {
    const id = record.identity;
    if (liveNode && root.contains(liveNode) && liveNode.getBoundingClientRect().height > 0) {
      return liveNode;
    }
    const candidate = (record.path || []).reduce((node, index) => node?.children?.[index], root);
    const confirms = (node) =>
      node &&
      node.getBoundingClientRect().height > 0 &&
      (!id || (node.tagName === id.tag && (node.textContent || '').trim().slice(0, 64) === id.text));
    if (confirms(candidate)) return candidate;
    if (id) {
      const matches = [...root.querySelectorAll(id.tag)].filter(
        (node) =>
          node.getBoundingClientRect().height > 0 &&
          (node.textContent || '').trim().slice(0, 64) === id.text
      );
      if (matches.length) {
        return matches.length === 1 || !candidate ? matches[0] : nearestMatch(matches, candidate);
      }
    }
    return root;
  }

  function capture(anchor) {
    const top = container.getBoundingClientRect().top;
    if (!anchor && following) return { bottom: true, top: container.scrollTop };
    anchor ||= visibleAnchor();
    return {
      bottom: following,
      top: container.scrollTop,
      anchor: anchor.root?.dataset?.anchorId,
      toolCallId: toolIdOf(anchor.node),
      rootPath: anchor.root ? [...container.children].indexOf(anchor.root) : null,
      path: anchor.path,
      identity: identity(anchor.node),
      offset: anchor.node ? anchor.node.getBoundingClientRect().top - top : 0,
      rootOffset: anchor.root ? anchor.root.getBoundingClientRect().top - top : 0,
    };
  }

  function rememberReading() {
    if (following) {
      reading = null;
      readingNode = null;
      readingRoot = null;
      snapshotLayout();
      return;
    }
    const anchor = visibleAnchor();
    readingRoot = anchor.root;
    readingNode = anchor.node;
    reading = capture(anchor);
    snapshotLayout();
  }

  function write(top) {
    container.scrollTop = top;
    expectedTop = container.scrollTop;
    lastTop = container.scrollTop;
  }

  function update() {
    if (navigating || batchDepth > 0) return;
    syncPendingScroll();
    if (navigating) return;
    if (following) {
      write(container.scrollHeight);
    } else if (reading) {
      const root = resolveRoot(reading, readingNode, readingRoot);
      const anchor = root && resolveAnchor(root, reading, readingNode);
      if (anchor) {
        readingRoot = root;
        if (anchor !== root) readingNode = anchor;
        const offset = anchor !== root ? reading.offset : reading.rootOffset ?? reading.offset;
        write(
          container.scrollTop +
            anchor.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            offset
        );
      }
    }
    snapshotLayout();
    onChange();
  }

  function schedule() {
    if (frame || batchDepth > 0) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      update();
    });
  }

  function restore(viewport) {
    if (!viewport) return;
    navigating = false;
    clearTimeout(settleTimer);
    following = Boolean(viewport.bottom);
    reading = viewport;
    readingNode = null;
    readingRoot = null;
    if (batchDepth === 0) {
      update();
      rememberReading();
      onChange();
    }
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
    if (
      event.type === 'keydown' &&
      !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
    ) {
      return;
    }
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.type === 'wheel' && !event.deltaY) return;
    lastGesture = event.timeStamp || performance.now();
    navigating = false;
    clearTimeout(settleTimer);
    expectedTop = null;
    if (event.type === 'wheel' || event.type === 'keydown') {
      const towardBottom =
        event.type === 'wheel'
          ? event.deltaY > 0
          : ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
      following = towardBottom && container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
    }
    rememberReading();
  }

  function scrolled() {
    if (expectedTop !== null && Math.abs(container.scrollTop - expectedTop) < 1) {
      lastTop = container.scrollTop;
      return;
    }
    const shrunk = container.scrollHeight < lastScrollHeight - 0.5;
    // Browser clamping `scrollTop` upward because content collapsed and the
    // previous offset no longer fits the shortened document is not a user scroll.
    const clamped = shrunk && lastTop > container.scrollHeight - container.clientHeight + 0.5;
    const targetTop = container.scrollTop;
    lastTop = targetTop;
    expectedTop = null;
    if (clamped) {
      if (navigating) settledNavigation();
      onChange();
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const fresh = now - lastGesture < 1000;
    const gap = container.scrollHeight - container.clientHeight - targetTop;
    const atBottom = gap <= 2;
    const oldMaxTop = Math.max(0, lastScrollHeight - lastClientHeight);
    const sameFrameGrowth =
      !shrunk &&
      !atBottom &&
      !fresh &&
      targetTop <= oldMaxTop + 1 &&
      Math.abs(container.scrollHeight - lastScrollHeight) > 1 &&
      lastLayout.length > 0;

    if (navigating) {
      settledNavigation();
      rememberReading();
      onChange();
      return;
    }

    if (sameFrameGrowth) {
      // `scrollTop` moved to an interior offset of the previous layout and DOM
      // height grew within the same frame before `scroll` was dispatched.
      // Reconstruct the intended anchor from `lastLayout` and compensate.
      const priorGap = oldMaxTop - targetTop;
      if (priorGap > lastClientHeight * 0.5) following = false;
      if (!following) {
        const recovered = anchorFromSnapshot(targetTop);
        if (recovered) {
          readingRoot = recovered.root;
          readingNode = recovered.node;
          reading = recovered.record;
          update();
          return;
        }
      }
      rememberReading();
      onChange();
      return;
    }

    if (fresh || gap > container.clientHeight * 0.5) following = atBottom;
    rememberReading();
    onChange();
  }

  /**
   * Reconcile any unacknowledged scroll change before starting a synchronous
   * DOM render transaction or scheduled frame update so anchors reflect the
   * true current scrollTop.
   */
  function syncPendingScroll() {
    if (navigating || syncingScroll) return;
    const moved =
      expectedTop !== null
        ? Math.abs(container.scrollTop - expectedTop) >= 1
        : Math.abs(container.scrollTop - lastTop) >= 1;
    if (!moved) return;
    syncingScroll = true;
    try {
      scrolled();
    } finally {
      syncingScroll = false;
    }
  }

  function beginMutation() {
    if (batchDepth === 0) syncPendingScroll();
    batchDepth += 1;
  }

  function endMutation(intent) {
    if (batchDepth > 0) batchDepth -= 1;
    if (batchDepth > 0) return;
    if (intent?.type === 'bottom') {
      restore({ bottom: true });
      return;
    }
    if (intent?.type === 'restore' && intent.viewport) {
      restore(intent.viewport);
      return;
    }
    if (!navigating) update();
  }

  const resize = new ResizeObserver(schedule);
  resize.observe(container);
  function observeContent() {
    for (const node of observed) {
      if (node.parentElement !== container) {
        resize.unobserve(node);
        observed.delete(node);
      }
    }
    for (const node of container.children) {
      if (!observed.has(node)) {
        observed.add(node);
        resize.observe(node);
      }
    }
    schedule();
  }
  const mutations = new MutationObserver(observeContent);
  mutations.observe(container, { childList: true, subtree: true, characterData: true });
  observeContent();
  container.addEventListener('scroll', scrolled, { passive: true });
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    container.addEventListener(type, userIntent, { passive: true });
  }
  const unregister = registerViewport(container, { navigate });

  return {
    get following() { return following; },
    get navigating() { return navigating; },
    pause() {
      following = false;
      navigating = false;
      clearTimeout(settleTimer);
      rememberReading();
    },
    beginMutation,
    endMutation,
    schedule,
    capture,
    restore,
    update,
    /**
     * True when auto-collapsing `node` would visibly disturb a parked reader:
     * 1. The reader's anchor is inside `node` (never collapse what they are reading).
     * 2. `node` is above the anchor and compensating `scrollTop - loss` would hit
     *    either the top (`< 0`) or bottom (`> maxAfterFold`) scroll boundary.
     * 3. `node` is below the anchor and the shortened document can no longer hold
     *    the current `scrollTop` (`scrollTop > maxAfterFold`).
     */
    foldingMoves(node) {
      if (following || navigating || !reading || !node) return false;
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0) return false;
      if (readingNode && node.contains?.(readingNode)) return true;
      const line = container.getBoundingClientRect().top + (reading.offset || 0);
      if (rect.top < line + 1 && rect.bottom > line - 1) return true;
      const loss = Math.max(0, rect.height - 40);
      const maxAfterFold = Math.max(0, container.scrollHeight - loss - container.clientHeight);
      if (rect.bottom <= line) {
        const compensated = container.scrollTop - loss;
        return compensated < -0.5 || compensated > maxAfterFold + 0.5;
      }
      return container.scrollTop > maxAfterFold + 0.5;
    },
    bottom() { restore({ bottom: true }); },
    dispose() {
      resize.disconnect();
      mutations.disconnect();
      unregister();
      cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      container.removeEventListener?.('scroll', scrolled);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        container.removeEventListener?.(type, userIntent);
      }
    },
  };
}

module.exports = { scrollToElement, focusWithoutScroll, createTranscriptViewport };

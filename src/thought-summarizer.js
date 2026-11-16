'use strict';

const { sameThought, shortActivityCaption } = require('./thought-caption');

/**
 * Host-side optional caption provider. `summarize` receives a bounded source
 * excerpt and AbortSignal and returns one line. No model/network dependency is
 * built in: configuring a provider is independent of the block/UI contract.
 */
class ThoughtSummarizer {
  constructor({ summarize = null, publish = () => {}, interval = 1000, timeout = 10000,
    maxChars = 6000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { summarize, publish, interval, timeout, maxChars, now, setTimer, clearTimer });
    this.current = null;
    this.running = null;
    this.timer = null;
    this.lastStarted = -Infinity;
    this.attempted = '';
    this.generation = 0;
  }

  setProvider(summarize) {
    this.generation++;
    this.running?.controller.abort();
    this.summarize = summarize;
    this.attempted = '';
    this.schedule();
  }

  update(block) {
    if (!sameThought(this.current, block) || this.current?.epoch !== block?.epoch) {
      this.generation++;
      this.running?.controller.abort();
      this.attempted = '';
    }
    this.current = block;
    if (block?.caption) this.running?.controller.abort();
    this.schedule();
  }

  key(block) {
    return JSON.stringify([block.sessionId, block.turnId, block.id, block.epoch, block.revision]);
  }

  schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const block = this.current;
    if (!this.summarize || this.running || !block || block.caption || !block.text.trim() ||
        (!block.completed && block.text.length <= 120) || this.attempted === this.key(block)) return;
    // A fixed deadline, not a trailing debounce: continuous deltas cannot starve it.
    const delay = Math.max(0, this.lastStarted + this.interval - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.run();
    }, delay);
    this.timer?.unref?.();
  }

  async run() {
    const block = this.current;
    if (!block || !this.summarize || this.running) return;
    const controller = new AbortController();
    const generation = this.generation;
    this.running = { controller };
    this.attempted = this.key(block);
    this.lastStarted = this.now();
    const deadline = this.setTimer(() => controller.abort(), this.timeout);
    deadline?.unref?.();
    try {
      const text = shortActivityCaption(await this.summarize({
        sessionId: block.sessionId, turnId: block.turnId, blockId: block.id,
        revision: block.revision, completed: block.completed,
        text: block.text.slice(-this.maxChars), signal: controller.signal,
      }));
      if (text && !controller.signal.aborted && generation === this.generation &&
          sameThought(this.current, block) && !this.current.caption) {
        this.publish({ sessionId: block.sessionId, turnId: block.turnId, id: block.id,
          epoch: block.epoch, revision: block.revision, text });
      }
    } catch {
      // A failed caption must never interrupt the main session. Retry only on new input.
    } finally {
      this.clearTimer(deadline);
      this.running = null;
      this.schedule();
    }
  }

  dispose() {
    this.update(null);
    this.setProvider(null);
  }
}

module.exports = { ThoughtSummarizer };

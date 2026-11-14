'use strict';

/**
 * @file Sub-agent strip polling and live child-session update merging for
 * `SessionPanel`.
 *
 * Direct child sessions are polled via REST and merged with low-latency ACP
 * `childUpdate` events so the webview strip stays responsive without injecting
 * sub-agent text into the parent transcript.
 *
 * State fields owned on `SessionPanel`:
 * - `_subagentsTimer`, `_subagentsRefreshing`
 * - `_subagentsCache`, `_subagentsPolled`, `_subagentsLive`, `_subagentsSignature`
 */

const { estimatePartTokens } = require('../turn-stats');
const { usageTotal } = require('../usage');

// A live sub-agent entry outlives its last ACP update so the strip does not
// flicker between polls; the REST poller prunes it afterwards.
const SUBAGENT_LIVE_TTL_MS = 15000;
const SUBAGENT_LIVE_BUSY_MS = 4000;

/**
 * A sub-agent session counts as running while `busy` is newer than `idle`.
 * Mirrors `isBusy` in sessions-view.js.
 */
function isRunning(session) {
  const time = (session && session.time) || {};
  if (!time.busy) return false;
  return !time.idle || time.idle < time.busy;
}

/**
 * Friendly label for the tool a sub-agent is currently using. Falls back to
 * the raw tool name for anything unknown.
 */
function subagentAction(name) {
  switch (name) {
    case 'bash':
    case 'shell':
    case 'execute':
      return 'run';
    case 'read':
      return 'read';
    case 'edit':
      return 'edit';
    case 'write':
      return 'write';
    case 'grep':
    case 'glob':
      return 'search';
    case 'task':
      return 'sub-agent';
    case 'webfetch':
      return 'fetch';
    default:
      return name || 'working';
  }
}

/**
 * The action label implied by a child-session update, or '' when the update
 * says nothing about what the sub-agent is doing right now.
 */
function childUpdateAction(update) {
  if (!update || typeof update !== 'object') return '';
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update':
      return subagentAction(update.kind || update.name || '');
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return 'working';
    default:
      return '';
  }
}

const panelSubagents = {
  _startSubagentsPolling() {
    if (this._subagentsTimer || this._disposed) return;
    this._refreshSubagents();
    this._refreshSmartReviews();
    this._subagentsTimer = setInterval(() => {
      this._refreshServerStatus();
      this._refreshSubagents();
      this._refreshSmartReviews();
    }, 3000);
    if (this._subagentsTimer.unref) this._subagentsTimer.unref();
  },

  async _refreshSubagents() {
    if (this._disposed || !this.sessionId || !this.cwd) return;
    if (this._subagentsRefreshing) return;
    this._subagentsRefreshing = true;
    try {
      const children = await this.deps.api.listSubagents(
        this.cwd,
        this.sessionId
      );
      if (this._disposed || !Array.isArray(children)) return;
      const polled = new Map();
      for (const child of children) {
        const updated =
          child.time && child.time.updated ? child.time.updated : 0;
        const cached = this._subagentsCache.get(child.id);
        let stats;
        if (cached && cached.updated === updated) {
          stats = cached.stats;
        } else {
          stats = await this._subagentStats(child.id);
          this._subagentsCache.set(child.id, { updated, stats });
        }
        const exactTokens = usageTotal(child.tokens);
        polled.set(child.id, {
          id: child.id,
          title: child.title || child.agent || 'Sub-agent',
          running: isRunning(child),
          action: stats.action,
          result: stats.result,
          tokens: exactTokens || stats.tokens,
          exact: exactTokens > 0,
          cost: Number(child.cost) || 0,
        });
      }
      const ids = new Set(polled.keys());
      for (const key of this._subagentsCache.keys()) {
        if (!ids.has(key)) this._subagentsCache.delete(key);
      }
      this._subagentsPolled = polled;
      this._publishSubagents();
    } catch (error) {
      this.deps.log(`Failed to refresh sub-agents: ${error.message}`);
    } finally {
      this._subagentsRefreshing = false;
    }
  },

  /**
   * A fresh webview starts without a strip: forget the last signature so the
   * current sub-agent state is posted again.
   */
  _resendSubagents() {
    this._subagentsSignature = '';
    this._publishSubagents();
  },

  /**
   * Drop live sub-agent entries the REST list no longer reports, once they have
   * been quiet long enough for the poller to have caught up.
   */
  _pruneLiveSubagents(ids) {
    const now = Date.now();
    for (const [id, live] of this._subagentsLive) {
      if (!ids.has(id) && now - (live.seen || 0) > SUBAGENT_LIVE_TTL_MS) {
        this._subagentsLive.delete(id);
      }
    }
  },

  /**
   * Merge the polled sub-agent list with the live child-session updates pushed
   * over ACP and post the result to the webview strip.
   */
  _publishSubagents() {
    if (this._disposed) return;
    this._pruneLiveSubagents(new Set(this._subagentsPolled.keys()));
    const now = Date.now();
    const merged = new Map();
    for (const [id, item] of this._subagentsPolled) merged.set(id, { ...item });
    for (const [id, live] of this._subagentsLive) {
      const base = merged.get(id);
      const active = live.running === true && now - (live.seen || 0) < SUBAGENT_LIVE_BUSY_MS;
      const running = active || (base ? base.running : false);
      if (base) {
        merged.set(id, {
          ...base,
          title: live.title || base.title,
          action: live.action || base.action,
          running,
        });
      } else {
        merged.set(id, {
          id,
          title: live.title || 'Sub-agent',
          action: live.action || '',
          running,
          tokens: 0,
          exact: false,
          cost: 0,
        });
      }
    }
    const items = Array.from(merged.values());
    let totalCost = 0;
    for (const item of items) totalCost += Number(item.cost) || 0;
    const signature = JSON.stringify([
      items.map((item) => [
        item.id,
        item.title,
        item.running,
        item.action,
        item.result,
        item.tokens,
        item.exact === true,
        item.cost,
      ]),
      Math.round(totalCost * 1e6),
    ]);
    if (signature === this._subagentsSignature) return;
    this._subagentsSignature = signature;
    this._post({ type: 'subagents', items, totalCost });
  },

  /**
   * A child session pushed one of its own updates over ACP. Only direct
   * children feed the strip: the transcript stays untouched, so sub-agent
   * output can never split the parent's text into fragments.
   */
  _onChildUpdate(params) {
    if (this._disposed || !params || !this.sessionId) return;
    if (params.type && params.type !== 'update') return;
    if (params.rootSessionId && params.rootSessionId !== this.sessionId) return;
    if (params.parentSessionId && params.parentSessionId !== this.sessionId) {
      return;
    }
    const childId = params.childSessionId;
    const update = params.update;
    if (!childId || !update || typeof update !== 'object') return;
    if (childId === this.sessionId) return;
    const live = this._subagentsLive.get(childId) || {
      title: '',
      action: '',
      running: null,
      seen: 0,
    };
    if (typeof params.title === 'string' && params.title) {
      live.title = params.title;
    }
    live.seen = Date.now();
    const action = childUpdateAction(update);
    if (action) {
      live.action = action;
      live.running = true;
    }
    this._subagentsLive.set(childId, live);
    this._publishSubagents();
  },

  /**
   * Estimate a sub-agent's current action (last tool used) and token usage from
   * its recent message history.
   */
  async _subagentStats(childId) {
    try {
      const recent = await this.deps.api.listMessages(childId, {
        limit: 20,
        order: 'desc',
      });
      const messages = (Array.isArray(recent) ? recent : []).slice().reverse();
      let action = '';
      let tokens = 0;
      let result = '';
      for (const message of messages) {
        if (!message || message.type !== 'assistant') continue;
        const parts = Array.isArray(message.content) ? message.content : [];
        const text = parts
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join(' ')
          .trim();
        if (text) result = text.replace(/\s+/g, ' ').slice(0, 240);
        let lastTool = '';
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          tokens += estimatePartTokens(part);
          if (part.type === 'tool') lastTool = part.name || 'tool';
        }
        if (lastTool) action = lastTool;
      }
      return { action: subagentAction(action), tokens, result };
    } catch (error) {
      this.deps.log(`Failed to load sub-agent stats for ${childId}: ${error.message}`);
      return { action: '', tokens: 0, result: '' };
    }
  },
};

module.exports = { isRunning, subagentAction, childUpdateAction, panelSubagents };

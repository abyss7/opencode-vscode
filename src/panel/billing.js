'use strict';

/**
 * @file Session billing, context window, cache metrics, and turn-statistics
 * synchronization for `SessionPanel`.
 *
 * Mixed onto `SessionPanel.prototype` so panel lifecycle code stays separate
 * from tariff/ledger accounting while preserving prototype-based unit tests.
 *
 * State fields owned on `SessionPanel`:
 * - `_modelRef`, `_modelLimit`, `_modelContextRequest`
 * - `_limits`, `_limitsTimer`, `_compaction`
 * - `_balanceErrorLogged`
 * - `_costSteps`, `_costPrices`, `_costPricesAt`, `_sessionCost`, `_costSplitPosted`
 */

const { getBalance } = require('../balance');
const { buildTurnStats } = require('../turn-stats');
const {
  usageTotal,
  matchModel,
  parseModelRef,
  resolveBudget,
  modelPrices,
  splitStepCost,
  summarizeCost,
} = require('../usage');

/**
 * Effective compaction settings from the config documents OpenCode reported
 * for a directory. Later documents override earlier ones.
 */
function readCompaction(documents) {
  const compaction = {};
  for (const document of Array.isArray(documents) ? documents : []) {
    const info = document && document.info;
    const value = info && info.compaction;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.auto === 'boolean') compaction.auto = value.auto;
    if (typeof value.buffer === 'number' && Number.isFinite(value.buffer)) {
      compaction.buffer = value.buffer;
    }
  }
  return compaction;
}

const panelBilling = {
  async _refreshLimits() {
    if (this._disposed) return;
    const ref = this._modelRef;
    try {
      const limits = await this.deps.api.getUsageLimits(this.cwd);
      if (this._disposed || this._modelRef !== ref) return;
      this._limits = limits;
      this._post({
        type: 'limits',
        model: ref,
        limits,
        budget: resolveBudget(limits, this._modelRef),
      });
    } catch (error) {
      this.deps.log(`Failed to load usage limits: ${error.message}`);
    }
  },

  async _refreshCompaction() {
    if (this._disposed) return;
    try {
      const documents = await this.deps.api.getConfig(this.cwd);
      if (this._disposed) return;
      this._compaction = readCompaction(documents);
      this._post({ type: 'compaction', compaction: this._compaction });
    } catch (error) {
      this.deps.log(`Failed to load compaction config: ${error.message}`);
    }
  },

  /**
   * Adopt the model selected in the config bar immediately, before the
   * server reports its own selection in the session info.
   */
  _syncModelOptions(options) {
    if (!Array.isArray(options)) return;
    const option = options.find((item) => item && item.category === 'model');
    if (!option) return;
    const ref = parseModelRef(option.currentValue);
    const effort = options.find((item) => item && item.id === 'effort');
    if (ref && effort) {
      if (effort.currentValue && effort.currentValue !== 'default') ref.variant = effort.currentValue;
      else delete ref.variant;
    }
    if (ref) this._setModelRef(ref);
  },

  _setModelRef(ref, force = false) {
    if (!ref || !ref.providerID || !ref.id) return;
    const previous = this._modelRef;
    const next = {
      providerID: ref.providerID,
      id: ref.id,
      inputPrice: previous && previous.inputPrice,
    };
    if (ref.variant) next.variant = ref.variant;
    const changed =
      !previous ||
      previous.providerID !== next.providerID ||
      previous.id !== next.id ||
      (next.variant || '') !== (previous.variant || '');
    if (!changed && !force) return;
    this._modelRef = next;
    if (force) this._costSplitPosted = '';
    this._post({ type: 'modelLimit', model: next, billing: { kind: 'pending' } });
    this._postCostSplit();
    this._refreshModelContext().then(() => {
      if (!this._disposed) this._refreshLimits();
    });
    this._refreshBalance(true);
  },

  /**
   * Provider-declared context and input windows for the selected model, plus
   * its input price, which the Console budget match needs.
   */
  async _refreshModelContext() {
    const ref = this._modelRef;
    if (this._disposed || !ref) return;
    const request = (this._modelContextRequest || 0) + 1;
    this._modelContextRequest = request;
    try {
      const [models, subscription] = await Promise.all([
        this.deps.api.listModels(this.cwd),
        ref.providerID === 'openai'
          ? this.deps.api.getChatGPTSubscription(this.cwd).catch((error) => {
              this.deps.log(`Failed to resolve OpenAI billing: ${error.message}`);
              return false;
            })
          : Promise.resolve(ref.providerID === 'zai-coding-plan'),
      ]);
      if (
        this._disposed ||
        this._modelContextRequest !== request ||
        !this._modelRef ||
        this._modelRef.providerID !== ref.providerID ||
        this._modelRef.id !== ref.id
      ) return;
      const record = matchModel(models, ref);
      const context = Number(record && record.limit && record.limit.context) || 0;
      const input = Number(record && record.limit && record.limit.input) || 0;
      const price = Number(
        record &&
          Array.isArray(record.cost) &&
          record.cost[0] &&
          record.cost[0].input
      );
      this._modelLimit = { context, input };
      if (this._modelRef) {
        this._modelRef.inputPrice = Number.isFinite(price) ? price : undefined;
      }
      this._post({
        type: 'modelLimit',
        context,
        input,
        model: { providerID: ref.providerID, id: ref.id },
        subscription,
        billing: subscription
          ? ref.providerID === 'zai-coding-plan'
            ? {
                kind: 'subscription',
                label: 'GLM Coding Plan',
                url: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
              }
            : { kind: 'subscription', label: 'ChatGPT plan', url: 'https://chatgpt.com/settings/usage' }
          : { kind: 'metered' },
      });
    } catch (error) {
      this.deps.log(`Failed to resolve model limits: ${error.message}`);
    }
  },

  async _refreshBalance(force = false) {
    if (this._disposed) return;
    const ref = this._modelRef;
    if (!ref || !ref.providerID) return;
    try {
      const balance = await getBalance(ref.providerID, {
        command: this.deps.getConfig().command,
        cwd: this.cwd,
        force,
      });
      if (this._disposed || this._modelRef !== ref) return;
      this._post({ type: 'balance', model: ref, balance: balance || null });
      this._balanceErrorLogged = false;
    } catch (error) {
      if (!this._balanceErrorLogged) {
        this._balanceErrorLogged = true;
        this.deps.log(
          `Failed to load balance for ${ref.providerID}: ${error.message}`
        );
      }
      if (this._disposed || this._modelRef !== ref) return;
      this._post({ type: 'balance', model: ref, balance: null });
    }
  },

  /**
   * Session-level cost, and the model in case it changed outside the config
   * bar. ACP reports usage once per turn; this keeps the line correct even
   * when the server omits its own `usage_update`.
   */
  async _refreshSessionUsage() {
    if (this._disposed || !this.sessionId) return;
    try {
      const info = await this.deps.api.getSession(this.sessionId);
      if (this._disposed || !info) return;
      if (info.model) this._setModelRef(info.model);
      if (typeof info.cost === 'number') {
        this._sessionCost = info.cost;
        this._post({
          type: 'update',
          update: {
            sessionUpdate: 'usage_update',
            cost: { amount: info.cost, currency: 'USD' },
          },
        });
        this._postCostSplit();
      }
    } catch (error) {
      this.deps.log(`Failed to refresh session usage: ${error.message}`);
    }
  },

  /**
   * Per-tariff spending for the cost tooltip. The server stores the billed cost
   * of every step, so each step is accounted once with the prices of its own
   * model: peak-hour rates and model switches stay honoured. Never scale a
   * model's spending to the mixed session total.
   */
  async _accountCosts(messages) {
    if (this._disposed || !this.sessionId) return;
    const steps = (Array.isArray(messages) ? messages : []).filter(
      (message) => message && message.type === 'assistant' && message.tokens
    );
    if (steps.length === 0) return;
    let prices = null;
    for (const message of steps) {
      const cached = this._costSteps.get(message.id);
      if (cached && cached.cost === message.cost) continue;
      if (!prices) {
        prices = await this._resolvePrices();
        if (this._disposed) return;
      }
      const model = message.model || {};
      const step = splitStepCost(
        message.tokens,
        prices.get(`${model.providerID}/${model.id}`),
        message.cost
      ) || (typeof message.cost === 'number'
        ? { tokens: {}, shares: {}, billed: message.cost } : null);
      if (step) this._costSteps.set(message.id, {
        ...step, cost: message.cost, model: `${model.providerID}/${model.id}`,
      });
    }
    this._postCostSplit();
  },

  async _resolvePrices() {
    if (this._costPrices && Date.now() - this._costPricesAt < 60000) {
      return this._costPrices;
    }
    const prices = new Map();
    try {
      const models = await this.deps.api.listModels(this.cwd);
      for (const record of Array.isArray(models) ? models : []) {
        const entry = modelPrices(record);
        if (entry) prices.set(`${record.providerID}/${record.id}`, entry);
      }
    } catch (error) {
      this.deps.log(`Failed to resolve model prices: ${error.message}`);
    }
    this._costPrices = prices;
    this._costPricesAt = Date.now();
    return prices;
  },

  _postCostSplit() {
    if (this._disposed || !this._modelRef) return;
    const model = this._modelRef;
    const steps = [...(this._costSteps?.values() || [])].filter(
      (step) => step.model === `${model.providerID}/${model.id}`
    );
    const summary = summarizeCost(steps);
    const labels = {
      input: 'input',
      output: 'output (incl. reasoning)',
      cacheRead: 'cache read',
      cacheWrite: 'cache write',
    };
    const message = {
      type: 'costSplit',
      model: { providerID: model.providerID, id: model.id },
      total: summary.total,
      rows: summary.rows
        .filter((row) => row.tokens > 0)
        .map((row) => ({
          key: row.key,
          label: labels[row.key],
          tokens: row.tokens,
          cost: row.cost,
        })),
    };
    const signature = JSON.stringify(message);
    if (signature === this._costSplitPosted) return;
    this._costSplitPosted = signature;
    this._post(message);
  },

  /**
   * ACP does not replay `usage_update` for loaded sessions, so estimate the
   * current context from the last assistant message before the first turn.
   */
  async _refreshUsageFromHistory() {
    if (this._disposed || !this.sessionId) return;
    try {
      const recent = await this.deps.api.listMessages(this.sessionId, {
        limit: 20,
        order: 'desc',
      });
      const candidates = recent
        .filter((message) => message && message.type === 'assistant' && message.id)
        .slice(0, 5);
      for (const candidate of candidates) {
        const message = await this.deps.api.getMessage(this.sessionId, candidate.id);
        if (this._disposed) return;
        if (!message) continue;
        const used = usageTotal(message.tokens);
        if (!used) continue;
        await this._postRestoredUsage(message, used);
        return;
      }
    } catch (error) {
      this.deps.log(`Failed to restore usage: ${error.message}`);
    }
  },

  async _postRestoredUsage(message, used) {
    const update = { sessionUpdate: 'usage_update', used };
    const model = (message && message.model) || this._modelRef;
    if (model) this._setModelRef(model);
    try {
      const info = await this.deps.api.getSession(this.sessionId);
      if (this._disposed) return;
      if (info && typeof info.cost === 'number') {
        this._sessionCost = info.cost;
        update.cost = { amount: info.cost, currency: 'USD' };
      }
    } catch (error) {
      this.deps.log(`Failed to restore session cost: ${error.message}`);
    }
    const size = await this._modelContextSize(model);
    if (this._disposed) return;
    if (size > 0) update.size = size;
    this._post({ type: 'update', update });
    this._postCacheStats(message);
    this._postCostSplit();
  },

  /**
   * Prompt composition of one completed step, for the session bar: how much of
   * the prompt came from the provider cache, and when it was measured.
   */
  _postCacheStats(message) {
    const tokens = message && message.tokens;
    if (!tokens || typeof tokens !== 'object') return;
    const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
    const input = Number(tokens.input) || 0;
    const read = Number(cache.read) || 0;
    const write = Number(cache.write) || 0;
    const prompt = input + read + write;
    if (prompt <= 0) return;
    const time = message.time && typeof message.time === 'object' ? message.time : {};
    const at = Number(time.completed) || Number(time.created) || 0;
    this._post({ type: 'cacheStats', prompt, input, read, write, at });
  },

  /**
   * Rebuild step and token counters from stored server history so a reloaded
   * session matches the turn that produced it.
   */
  async _restoreTurnStats() {
    if (this._disposed || !this.sessionId) return;
    try {
      const messages = await this.deps.api.listAllMessages(this.sessionId);
      if (this._disposed || messages.length === 0) return;
      this._postMessageTimes(messages);
      const turns = buildTurnStats(messages);
      if (turns.length > 0) {
        this._post({ type: 'turnStats', turns, scope: 'all' });
      }
      await this._accountCosts(messages);
    } catch (error) {
      this.deps.log(`Failed to restore turn stats: ${error.message}`);
    }
  },

  /**
   * Cheap variant used after a turn ends: refresh only the newest block.
   */
  async _refreshLastTurnStats() {
    if (this._disposed || !this.sessionId) return;
    try {
      const recent = await this.deps.api.listMessages(this.sessionId, {
        limit: 100,
        order: 'desc',
      });
      if (this._disposed || recent.length === 0) return;
      this._postMessageTimes(recent);
      const turns = buildTurnStats(recent.slice().reverse());
      const last = turns[turns.length - 1];
      if (last) this._post({ type: 'turnStats', turns: [last], scope: 'last' });
      const latest = recent.find(
        (item) => item && item.type === 'assistant' && item.tokens
      );
      this._postCacheStats(latest);
      await this._accountCosts(recent);
    } catch (error) {
      this.deps.log(`Failed to refresh turn stats: ${error.message}`);
    }
  },

  _postMessageTimes(messages) {
    const times = messages
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .map((message) => ({
        id: message.id,
        timestamp: message.time?.streamed || message.time?.created,
      }))
      .filter((message) => message.id && Number.isFinite(message.timestamp) && message.timestamp > 0);
    this._post({ type: 'messageTimes', times });
  },

  async _modelContextSize(model) {
    if (!model || !model.id) return 0;
    if (
      this._modelLimit &&
      this._modelLimit.context > 0 &&
      this._modelRef &&
      this._modelRef.id === model.id &&
      this._modelRef.providerID === model.providerID
    ) {
      return this._modelLimit.context;
    }
    try {
      const models = await this.deps.api.listModels(this.cwd);
      const record = matchModel(models, model);
      const limit = record && record.limit && record.limit.context;
      return typeof limit === 'number' && limit > 0 ? limit : 0;
    } catch (error) {
      this.deps.log(`Failed to resolve model limits: ${error.message}`);
      return 0;
    }
  },

  _startLimitsTimer() {
    if (this._limitsTimer || this._disposed) return;
    this._limitsTimer = setInterval(() => {
      this._refreshLimits();
      this._refreshCompaction();
      this._refreshBalance();
    }, 60000);
    if (this._limitsTimer.unref) this._limitsTimer.unref();
  },
};

module.exports = { readCompaction, panelBilling };

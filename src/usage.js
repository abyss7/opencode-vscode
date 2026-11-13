'use strict';

/**
 * Total tokens a step used, matching the server's own accounting: the prompt
 * plus everything generated in that step.
 */
function usageTotal(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  const cache = tokens.cache || {};
  const total =
    Number(tokens.input || 0) +
    Number(tokens.output || 0) +
    Number(tokens.reasoning || 0) +
    Number(cache.read || 0) +
    Number(cache.write || 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * Compaction threshold, mirroring the server: the provider-declared input
 * window wins over the context window, a configured buffer shorter than that
 * window is subtracted, otherwise the default is max(15% of the window, 16k
 * for windows of 32k and above).
 */
function compactionThreshold(options = {}) {
  const context = Number(options.context) || 0;
  const input = Number(options.input) || 0;
  const total = input || context;
  if (total <= 0) return 0;
  const compaction = options.compaction || {};
  if (compaction.auto === false) return 0;
  const buffer = typeof compaction.buffer === 'number' ? compaction.buffer : NaN;
  if (Number.isFinite(buffer) && buffer < total) {
    return total - buffer;
  }
  return total - Math.max(Math.floor(total * 0.15), total >= 32000 ? 16000 : 0);
}

/**
 * Model references are serialized as `providerID/modelID`, optionally with a
 * `#variant` suffix. Model IDs may contain slashes, so only the first slash
 * separates the provider.
 */
function parseModelRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  const providerID = raw.slice(0, slash);
  const rest = raw.slice(slash + 1);
  const hash = rest.indexOf('#');
  const id = hash >= 0 ? rest.slice(0, hash) : rest;
  if (!id) return null;
  const variant = hash >= 0 ? rest.slice(hash + 1) : '';
  return variant ? { providerID, id, variant } : { providerID, id };
}

/**
 * Catalog record for a model reference.
 */
function matchModel(models, ref) {
  if (!Array.isArray(models) || !ref || !ref.id) return null;
  return (
    models.find(
      (item) =>
        item &&
        item.id === ref.id &&
        (!ref.providerID || !item.providerID || item.providerID === ref.providerID)
    ) || null
  );
}

/**
 * Console budget that limits the selected model, with the remaining amount
 * already resolved. `scope: "each"` applies the limit to every covered model
 * separately, `combined` shares it across them.
 */
function resolveBudget(limits, modelRef) {
  if (!limits || !Array.isArray(limits.budgets) || !modelRef) return null;
  const providerID = modelRef.providerID;
  const modelID = modelRef.id;
  if (!providerID || !modelID) return null;
  const inputPrice = Number(modelRef.inputPrice);
  const covered = (budget) =>
    Array.isArray(budget.models) &&
    budget.models.some(
      (item) =>
        item && item.providerID === providerID && item.modelID === modelID
    );
  const applicable = limits.budgets.filter((budget) => {
    if (
      !budget ||
      typeof budget.limit !== 'number' ||
      typeof budget.spent !== 'number'
    ) {
      return false;
    }
    if (
      typeof budget.inputPriceAtLeast === 'number' &&
      Number.isFinite(inputPrice) &&
      inputPrice < budget.inputPriceAtLeast
    ) {
      return false;
    }
    if (budget.coverage === 'all') return true;
    return covered(budget);
  });
  if (applicable.length === 0) return null;
  const budget =
    applicable.find((item) => item.picked === true) || applicable[0];
  const entry = Array.isArray(budget.models)
    ? budget.models.find(
        (item) =>
          item && item.providerID === providerID && item.modelID === modelID
      )
    : null;
  const modelSpent =
    entry && typeof entry.spent === 'number' ? entry.spent : null;
  const spent =
    budget.scope === 'each' && modelSpent !== null ? modelSpent : budget.spent;
  return {
    id: budget.id || '',
    limit: budget.limit,
    spent: budget.spent,
    modelSpent,
    remaining: Math.max(0, budget.limit - spent),
    resetsAt: typeof budget.resetsAt === 'number' ? budget.resetsAt : 0,
    modelMatched: Boolean(entry),
    label: (entry && entry.name) || `${providerID}/${modelID}`,
  };
}

/**
 * Per-million prices of a model catalog record, or null when the record has no
 * cost table. `reasoning` is billed as output, cache read/write separately.
 */
function modelPrices(record) {
  const cost = record && Array.isArray(record.cost) ? record.cost[0] : null;
  if (!cost || typeof cost !== 'object') return null;
  const cache = cost.cache && typeof cost.cache === 'object' ? cost.cache : {};
  const prices = {
    input: Number(cost.input) || 0,
    output: Number(cost.output) || 0,
    cacheRead: Number(cache.read) || 0,
    cacheWrite: Number(cache.write) || 0,
  };
  const any = prices.input + prices.output + prices.cacheRead + prices.cacheWrite;
  return any > 0 ? prices : null;
}

/**
 * Split one step's billed cost across the tariffs. The stored `cost` is
 * authoritative — a provider may bill with peak-hour rates that no catalog
 * reflects — so the shares are normalised to it; the price table only fixes
 * the proportions. Without a stored cost the prices are used as is.
 */
function splitStepCost(tokens, prices, cost) {
  if (!tokens || typeof tokens !== 'object' || !prices) return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const counts = {
    input: Number(tokens.input) || 0,
    output: (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0),
    cacheRead: Number(cache.read) || 0,
    cacheWrite: Number(cache.write) || 0,
  };
  const weights = {
    input: counts.input * prices.input,
    output: counts.output * prices.output,
    cacheRead: counts.cacheRead * prices.cacheRead,
    cacheWrite: counts.cacheWrite * prices.cacheWrite,
  };
  const weightSum =
    weights.input + weights.output + weights.cacheRead + weights.cacheWrite;
  const stored = Number(cost);
  const billed =
    Number.isFinite(stored) && stored >= 0 ? stored : weightSum / 1000000;
  const shares = {};
  for (const key of Object.keys(counts)) {
    shares[key] = weightSum > 0 ? (billed * weights[key]) / weightSum : 0;
  }
  const used = counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
  if (used <= 0) return null;
  return { tokens: counts, shares, billed };
}

/**
 * Session totals per tariff. `cost` is the stored session cost, which also
 * covers steps the API no longer lists (pre-compaction history), so the
 * collected shares are scaled up to it; the proportions survive unchanged.
 */
function summarizeCost(steps, cost) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const shares = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let collected = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step) continue;
    collected += Number(step.billed) || 0;
    for (const key of Object.keys(tokens)) {
      tokens[key] += Number(step.tokens[key]) || 0;
      shares[key] += Number(step.shares[key]) || 0;
    }
  }
  const stored = Number(cost);
  const total = Number.isFinite(stored) && stored > 0 ? stored : collected;
  const scale = collected > 0 && total > 0 ? total / collected : 1;
  return {
    total,
    scale,
    rows: [
      { key: 'input', tokens: tokens.input, cost: shares.input * scale },
      { key: 'output', tokens: tokens.output, cost: shares.output * scale },
      { key: 'cacheRead', tokens: tokens.cacheRead, cost: shares.cacheRead * scale },
      { key: 'cacheWrite', tokens: tokens.cacheWrite, cost: shares.cacheWrite * scale },
    ],
  };
}

module.exports = {
  usageTotal,
  compactionThreshold,
  parseModelRef,
  matchModel,
  resolveBudget,
  modelPrices,
  splitStepCost,
  summarizeCost,
};

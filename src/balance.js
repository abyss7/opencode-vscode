'use strict';

const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');

const execFileAsync = promisify(execFile);

const TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;

// Only providers with a read-only balance API are listed. The key comes from
// the OpenCode credential store, so the extension never asks for it again.
const PROVIDERS = {
  deepseek: {
    credential: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/user/balance',
    parse: parseDeepSeekBalance,
  },
  'zai-coding-plan': {
    credential: 'zai-coding-plan',
    envKey: 'ZHIPU_API_KEY',
    url: 'https://api.z.ai/api/monitor/usage/quota/limit',
    parse: parseZaiPlanUsage,
  },
};

const cache = new Map();

// Slow or IPv6-broken networks defeat Node's happy-eyeballs default: each
// address attempt gets 250ms, so a >250ms IPv4 handshake plus dead AAAA
// records surface as ETIMEDOUT even though the host is reachable. Give every
// attempt a budget comparable to the overall request timeout instead.
const CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

function requestJsonDefault(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('balance response is not JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('balance request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse `opencode auth export <target>`. The command may print log lines
 * before the JSON document, so scan for the first parseable value.
 */
function parseCredentialExport(text) {
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '[' && character !== '{') continue;
    let data;
    try {
      data = JSON.parse(value.slice(index));
    } catch {
      continue;
    }
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.credentials)) return data.credentials;
    if (data && typeof data === 'object') return [data];
    return [];
  }
  return [];
}

function parseDeepSeekBalance(data) {
  if (!data || typeof data !== 'object') return null;
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  for (const info of infos) {
    if (!info || typeof info !== 'object') continue;
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount)) continue;
    return {
      provider: 'deepseek',
      currency: typeof info.currency === 'string' ? info.currency : 'USD',
      amount,
      granted: Number(info.granted_balance) || 0,
      toppedUp: Number(info.topped_up_balance) || 0,
      available: data.is_available !== false,
      fetchedAt: Date.now(),
    };
  }
  return null;
}

/**
 * GLM Coding Plan windows from the Z.AI monitor API. `usage` is the window
 * quota and `currentValue` the consumed part; `unit` 3 is the five-hour
 * rolling window and `unit` 6 the weekly one, while a `TOKENS_LIMIT` row
 * without a unit is the legacy shape of the five-hour window. `TIME_LIMIT`
 * rows (monthly tool quotas) are not part of the model usage line.
 */
function parseZaiPlanUsage(data) {
  const payload = data && typeof data === 'object' ? data.data : null;
  const level = payload && typeof payload.level === 'string' ? payload.level : '';
  const limits = payload && Array.isArray(payload.limits) ? payload.limits : [];
  const windows = [];
  const seen = new Set();
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'TOKENS_LIMIT' && item.type !== 'CREDIT_LIMIT') continue;
    const unit = Number(item.unit);
    if (Number.isFinite(unit) && unit !== 3 && unit !== 6) continue;
    const kind = unit === 6 ? 'weekly' : 'fiveHour';
    if (seen.has(kind)) continue;
    const percentage = Number(item.percentage);
    if (!Number.isFinite(percentage)) continue;
    seen.add(kind);
    windows.push({
      kind,
      order: kind === 'weekly' ? 1 : 0,
      unit: item.type === 'CREDIT_LIMIT' ? 'credits' : 'tokens',
      used: Number(item.currentValue) || 0,
      limit: Number(item.usage) || 0,
      remaining: Number(item.remaining) || 0,
      percentage: Math.max(0, Math.min(100, Math.round(percentage))),
      resetsAt: Number(item.nextResetTime) || 0,
    });
  }
  if (windows.length === 0) return null;
  windows.sort((a, b) => a.order - b.order);
  for (const window of windows) delete window.order;
  return {
    provider: 'zai-coding-plan',
    plan: level,
    windows,
    fetchedAt: Date.now(),
  };
}

// ChatGPT exposes percentages, not token/credit quotas. Window durations come
// from the response: some plans only have a weekly window.
function parseChatGPTUsage(data) {
  if (!data || typeof data !== 'object') return null;
  const windows = [];
  for (const [slot, item] of Object.entries(data.rate_limit || {})) {
    if (!['primary_window', 'secondary_window'].includes(slot) || !item) continue;
    const percentage = item.used_percent;
    const seconds = item.limit_window_seconds;
    if (typeof percentage !== 'number' || !Number.isFinite(percentage) ||
        typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
    const kind = seconds === 604800 ? 'weekly' : seconds === 18000 ? 'fiveHour' : slot;
    windows.push({
      kind,
      label: seconds === 604800 ? 'weekly' : seconds === 18000 ? '5-hour' : `${seconds / 3600}-hour`,
      durationSeconds: seconds,
      percentage: Math.max(0, Math.min(100, Math.round(percentage))),
      resetsAt: typeof item.reset_at === 'number' && Number.isFinite(item.reset_at)
        ? item.reset_at * 1000 : 0,
    });
  }
  if (windows.length === 0) return null;
  windows.sort((a, b) => a.durationSeconds - b.durationSeconds);
  return {
    provider: 'openai',
    plan: typeof data.plan_type === 'string' ? data.plan_type : '',
    windows,
    fetchedAt: Date.now(),
  };
}

async function chatGPTRequest(options) {
  const exec = options.exec || execFileAsync;
  const { stdout } = await exec(options.command || 'opencode', ['auth', 'export', 'openai'], {
    cwd: options.cwd,
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  // Never use an inactive Codex account, an API key, or token-sharing auth.
  const credential = parseCredentialExport(stdout).find((item) => item && item.active === true);
  const value = credential && credential.value;
  if (!value || value.type !== 'oauth' || value.methodID !== 'chatgpt-browser' ||
      typeof value.access !== 'string' || !value.access) return null;
  let accountID = value.metadata && value.metadata.accountID;
  if (!accountID) {
    try {
      const claims = JSON.parse(Buffer.from(value.access.split('.')[1], 'base64url').toString());
      accountID = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    } catch { /* Opaque tokens need account metadata. */ }
  }
  if (typeof accountID !== 'string' || !accountID) return null;
  // No secrets in cache keys or messages. Re-read auth before consulting the
  // cache so signing out/switching accounts cannot reuse another account's quota.
  const scope = createHash('sha256').update(JSON.stringify([
    options.command || 'opencode', options.cwd || '', accountID, value.access,
  ])).digest('hex');
  return {
    key: `openai:${scope}`,
    fetch: async () => {
      const request = options.request || requestJsonDefault;
      const data = await request('https://chatgpt.com/backend-api/wham/usage', {
        authorization: `Bearer ${value.access}`,
        'ChatGPT-Account-Id': accountID,
        accept: 'application/json',
      });
      const balance = parseChatGPTUsage(data);
      if (!balance) throw new Error('ChatGPT response has no usage windows');
      return balance;
    },
  };
}

async function readCredential(command, provider, options) {
  const env = options.env === undefined ? process.env : options.env;
  const fromEnv = provider.envKey && env ? env[provider.envKey] : '';
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  const exec = options.exec || execFileAsync;
  const { stdout } = await exec(command, ['auth', 'export', provider.credential], {
    cwd: options.cwd,
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  const credentials = parseCredentialExport(stdout);
  const active = credentials.find((item) => item && item.active === true);
  const credential = active || credentials[0];
  const key =
    credential && credential.value && typeof credential.value.key === 'string'
      ? credential.value.key
      : '';
  if (!key) throw new Error('no credential found');
  return key;
}

async function fetchProviderBalance(provider, options) {
  const key = await readCredential(
    options.command || 'opencode',
    provider,
    options
  );
  const request = options.request || requestJsonDefault;
  const data = await request(provider.url, {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
  });
  const balance = provider.parse(data);
  if (!balance) throw new Error('balance response has no usable amount');
  return balance;
}

/**
 * Current account balance for a provider, or null when the provider has no
 * balance API. Concurrent callers share one request; failures leave the last
 * good value in place.
 */
async function getBalance(providerID, options = {}) {
  const provider = PROVIDERS[providerID];
  const chatGPT = providerID === 'openai' ? await chatGPTRequest(options) : null;
  if (!provider && !chatGPT) return null;
  const key = chatGPT ? chatGPT.key : providerID;
  let entry = cache.get(key);
  if (!entry) {
    entry = { value: null, at: 0, inflight: null };
    cache.set(key, entry);
  }
  const fresh =
    options.force !== true && entry.at > 0 && Date.now() - entry.at < TTL_MS;
  if (fresh) return entry.value;
  if (entry.inflight) return entry.inflight;
  entry.inflight = (chatGPT ? chatGPT.fetch() : fetchProviderBalance(provider, options)).then(
    (value) => {
      entry.value = value;
      entry.at = Date.now();
      entry.inflight = null;
      return value;
    },
    (error) => {
      entry.inflight = null;
      if (chatGPT && (error.statusCode === 401 || error.statusCode === 403)) {
        cache.delete(key);
        throw error;
      }
      if (entry.value) return entry.value;
      throw error;
    }
  );
  return entry.inflight;
}

function resetBalanceCache() {
  cache.clear();
}

module.exports = {
  getBalance,
  parseCredentialExport,
  parseDeepSeekBalance,
  parseZaiPlanUsage,
  parseChatGPTUsage,
  resetBalanceCache,
};

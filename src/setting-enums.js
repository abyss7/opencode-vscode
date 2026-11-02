'use strict';

/**
 * Settings dropdowns.
 *
 * VS Code only renders an `enum` as a dropdown, and `contributes.configuration`
 * is read once per extension host, so the model and agent lists cannot come
 * from the running service directly. Instead the lists are written into the
 * extension's own `package.json` at startup; a reload picks them up.
 *
 * The values stay plain OpenCode strings (`provider/model#variant`, agent id),
 * which keeps `opencode.json(c)` readable and the settings sync unchanged.
 */

const fs = require('node:fs');

const MODEL_SETTING = 'opencode.model';
const AGENT_SETTING = 'opencode.default_agent';
const ENUM_KEYS = ['enum', 'enumDescriptions', 'markdownEnumDescriptions'];

function contextLabel(model) {
  const context = model && model.limit ? Number(model.limit.context) : NaN;
  if (!Number.isFinite(context) || context <= 0) return '';
  if (context >= 1000000) {
    const millions = (context / 1000000).toFixed(context >= 10000000 ? 0 : 1);
    return `${millions.replace(/\.0$/, '')}M context`;
  }
  return context >= 1000 ? `${Math.round(context / 1000)}k context` : `${context} context`;
}

/** Compact `provider/model#variant` form of either stored shape. */
function modelRefString(value) {
  if (typeof value === 'string') return value || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const providerID = typeof value.providerID === 'string' ? value.providerID : '';
  const model = typeof value.model === 'string' ? value.model : '';
  if (!providerID || !model) return undefined;
  const variant = typeof value.variant === 'string' && value.variant ? value.variant : '';
  return `${providerID}/${model}${variant ? `#${variant}` : ''}`;
}

function variantIds(model) {
  const variants = model && Array.isArray(model.variants) ? model.variants : [];
  return variants
    .map((variant) => (typeof variant === 'string' ? variant : variant && variant.id))
    .filter((id) => typeof id === 'string' && id);
}

/**
 * `enum` values and matching descriptions for `opencode.model`: one entry per
 * model and one per declared variant. `extra` keeps the configured value in the
 * list when the catalogue no longer reports it.
 */
function modelEnumEntries(models, extra) {
  const values = [];
  const descriptions = [];
  const seen = new Set();
  const add = (value, description) => {
    if (typeof value !== 'string' || !value || seen.has(value)) return;
    seen.add(value);
    values.push(value);
    descriptions.push(description || value);
  };

  const list = (Array.isArray(models) ? models : [])
    .filter(
      (model) =>
        model &&
        typeof model.id === 'string' &&
        model.id &&
        typeof model.providerID === 'string' &&
        model.providerID
    )
    .slice()
    .sort((a, b) =>
      `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`)
    );

  for (const model of list) {
    // Prices are left out on purpose: providers change them by time of day, and
    // a fluctuating description would rewrite package.json on every start.
    const base = `${model.providerID}/${model.id}`;
    const detail = [model.name, contextLabel(model)].filter(Boolean).join(' · ');
    add(base, detail);
    for (const variant of variantIds(model)) {
      add(`${base}#${variant}`, [detail, `variant ${variant}`].filter(Boolean).join(' · '));
    }
  }

  for (const value of Array.isArray(extra) ? extra : []) add(value, value);
  return { values, descriptions };
}

/**
 * `enum` values for `opencode.default_agent`: visible primary agents only.
 * Hidden built-ins (title, summary, compaction) and subagents cannot be the
 * default agent of a new session.
 */
function agentEnumEntries(agents, extra) {
  const values = [];
  const descriptions = [];
  const seen = new Set();
  const add = (value, description) => {
    if (typeof value !== 'string' || !value || seen.has(value)) return;
    seen.add(value);
    values.push(value);
    descriptions.push(description || value);
  };

  const list = (Array.isArray(agents) ? agents : [])
    .filter(
      (agent) =>
        agent &&
        typeof agent.id === 'string' &&
        agent.id &&
        agent.mode === 'primary' &&
        !agent.hidden
    )
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));

  for (const agent of list) {
    add(agent.id, typeof agent.description === 'string' ? agent.description : agent.name);
  }

  for (const value of Array.isArray(extra) ? extra : []) add(value, value);
  return { values, descriptions };
}

function sameEnum(property, entries) {
  if (!property) return true;
  return (
    JSON.stringify(property.enum) === JSON.stringify(entries.values) &&
    JSON.stringify(property.enumDescriptions) === JSON.stringify(entries.descriptions)
  );
}

function applyEnum(property, entries) {
  if (!property) return;
  if (entries.values.length === 0) {
    for (const key of ENUM_KEYS) delete property[key];
    return;
  }
  property.enum = entries.values.slice();
  property.enumDescriptions = entries.descriptions.slice();
}

function configurationProperties(pkg) {
  const configuration = pkg && pkg.contributes && pkg.contributes.configuration;
  const categories = Array.isArray(configuration) ? configuration : [configuration];
  let fallback = null;
  for (const category of categories) {
    if (!category || !category.properties) continue;
    if (category.properties[MODEL_SETTING] || category.properties[AGENT_SETTING]) {
      return category.properties;
    }
    if (!fallback) fallback = category.properties;
  }
  return fallback;
}

/**
 * Writes the model and agent `enum` arrays into the extension's `package.json`.
 * Nothing else in the file is touched; an unchanged list is left alone so the
 * file is not rewritten at every window start.
 */
function updateEnums(options) {
  const { file, log = () => {} } = options;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log(`Setting enums: cannot read ${file}: ${error.message || error}`);
    return { changed: false, model: false, agent: false };
  }

  const properties = configurationProperties(pkg);
  if (!properties) {
    log(`Setting enums: ${file} has no configuration properties`);
    return { changed: false, model: false, agent: false };
  }

  const extraModel = [modelRefString(options.currentModel)].filter(Boolean);
  const extraAgent = [options.currentAgent].filter(
    (value) => typeof value === 'string' && value
  );
  const models = modelEnumEntries(options.models, extraModel);
  const agents = agentEnumEntries(options.agents, extraAgent);

  // An empty catalogue is a failed request, not an empty installation: keep the
  // previous list instead of wiping the dropdown.
  const hasModels = Array.isArray(options.models) && options.models.length > 0;
  const hasAgents = Array.isArray(options.agents) && options.agents.length > 0;
  const modelChanged = hasModels && !sameEnum(properties[MODEL_SETTING], models);
  const agentChanged = hasAgents && !sameEnum(properties[AGENT_SETTING], agents);
  if (!modelChanged && !agentChanged) {
    return { changed: false, model: false, agent: false };
  }

  if (modelChanged) applyEnum(properties[MODEL_SETTING], models);
  if (agentChanged) applyEnum(properties[AGENT_SETTING], agents);

  try {
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (error) {
    log(`Setting enums: cannot write ${file}: ${error.message || error}`);
    return { changed: false, model: false, agent: false };
  }

  return { changed: true, model: modelChanged, agent: agentChanged };
}

/**
 * Startup refresh: asks the local service for the catalogue and updates the
 * `enum`s. The service is never started for this alone, so a window opened
 * without a running service simply keeps the previous list.
 */
async function refreshSettingEnums(options) {
  const { vscode, api, cwd, file, log = () => {} } = options;
  if (!file) return { changed: false, model: false, agent: false };
  if (!api || typeof api.listModels !== 'function') {
    return { changed: false, model: false, agent: false };
  }
  if (typeof api.isRunning === 'function' && !(await api.isRunning())) {
    log('Setting enums: OpenCode service is not running; keeping the current lists');
    return { changed: false, model: false, agent: false };
  }

  const [models, agents] = await Promise.all([
    api.listModels(cwd).catch(() => []),
    typeof api.listAgents === 'function' ? api.listAgents(cwd).catch(() => []) : [],
  ]);

  let configuration;
  try {
    configuration = vscode.workspace.getConfiguration('opencode');
  } catch {
    configuration = undefined;
  }
  const currentModel = configuration ? configuration.get('model') : undefined;
  const currentAgent = configuration ? configuration.get('default_agent') : undefined;

  const result = updateEnums({ file, models, agents, currentModel, currentAgent, log });
  log(
    `Setting enums: ${models.length} model(s), ${agents.length} agent(s); ` +
      `changed: ${result.changed}`
  );
  if (result.changed) {
    log(
      `Setting enums updated (model: ${result.model}, agent: ${result.agent}); ` +
        'run "Developer: Reload Window" to refresh the Settings dropdowns'
    );
  }
  return result;
}

module.exports = {
  MODEL_SETTING,
  AGENT_SETTING,
  modelRefString,
  modelEnumEntries,
  agentEnumEntries,
  updateEnums,
  refreshSettingEnums,
};

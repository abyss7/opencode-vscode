'use strict';

const BUILTINS = { build: 'Build', plan: 'Plan', explore: 'Explore', general: 'General' };

function agentLabel(id, name) {
  if (typeof name === 'string' && name.trim() && name.toLowerCase() !== String(id).toLowerCase()) return name;
  return BUILTINS[id] || name || id;
}

function normalizeAgentOptions(options) {
  return options.map((option) => {
    if (!option || !(option.id === 'mode' || option.id === 'agent' || option.category === 'mode')) return option;
    return { ...option, options: (option.options || []).map((item) => ({
      ...item, name: agentLabel(item.value, item.name),
    })) };
  });
}

module.exports = { agentLabel, normalizeAgentOptions };

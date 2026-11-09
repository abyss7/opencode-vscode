'use strict';

/**
 * Default model picker.
 *
 * The native Settings editor cannot ask the running service for a list, so the
 * model setting stays a string. This command fills that string from the live
 * catalogue: a searchable model list grouped by provider, then the effort
 * (variant) declared by the chosen model. It is linked from the setting's
 * description, so no manifest rewrite or window reload is needed.
 */

const { variantIds } = require('./model-ref');

const VARIANT_LABELS = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};

function contextLabel(model) {
  const context = model && model.limit ? Number(model.limit.context) : NaN;
  if (!Number.isFinite(context) || context <= 0) return '';
  if (context >= 1000000) {
    const millions = (context / 1000000).toFixed(context >= 10000000 ? 0 : 1);
    return `${millions.replace(/\.0$/, '')}M context`;
  }
  return context >= 1000 ? `${Math.round(context / 1000)}k context` : `${context} context`;
}

function modelRef(model) {
  return `${model.providerID}/${model.id}`;
}

/**
 * QuickPick items for the catalogue: a separator per provider, then one item
 * per model. Separators are skipped when the API does not expose the kind.
 */
function modelChoices(models, separatorKind) {
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
    .sort((a, b) => modelRef(a).localeCompare(modelRef(b)));

  const choices = [];
  let provider = '';
  for (const model of list) {
    if (model.providerID !== provider) {
      provider = model.providerID;
      if (separatorKind !== undefined) choices.push({ label: provider, kind: separatorKind });
    }
    const variants = variantIds(model);
    const detail = [
      model.name && model.name !== model.id ? model.name : '',
      contextLabel(model),
      variants.length ? `effort: ${variants.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    choices.push({
      label: model.name || model.id,
      description: modelRef(model),
      detail,
      model,
    });
  }
  return choices;
}

/** Effort candidates: the model default plus every declared variant. */
function effortChoices(model) {
  const ref = modelRef(model);
  return [
    {
      label: 'Default',
      description: ref,
      detail: 'No effort suffix; the model decides',
      variant: '',
    },
    ...variantIds(model).map((id) => ({
      label: VARIANT_LABELS[id] || id,
      description: `${ref}#${id}`,
      variant: id,
    })),
  ];
}

/**
 * Asks for a model and its effort and stores `provider/model#variant` in
 * `opencode.model`. Returns the stored value, or null when the user cancels.
 */
async function selectDefaultModel(options) {
  const { vscode, api, cwd, log = () => {} } = options;
  const models = await api.listModels(cwd);
  const separatorKind =
    vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator;
  const choices = modelChoices(models, separatorKind);
  if (!choices.some((choice) => choice.model)) {
    vscode.window.showWarningMessage(
      'No OpenCode models are available. Configure a provider first.'
    );
    return null;
  }

  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Default model for new sessions',
    placeHolder: 'Search by model or provider',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked.model) return null;

  let variant = '';
  if (variantIds(picked.model).length > 0) {
    const effort = await vscode.window.showQuickPick(effortChoices(picked.model), {
      title: `Effort for ${picked.model.name || picked.model.id}`,
      placeHolder: 'Default uses the effort the model starts with',
    });
    if (!effort) return null;
    variant = effort.variant;
  }

  const value = `${modelRef(picked.model)}${variant ? `#${variant}` : ''}`;
  const uri = cwd ? vscode.Uri.file(cwd) : undefined;
  const target =
    cwd && vscode.workspace.getWorkspaceFolder(uri)
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('opencode', uri).update('model', value, target);
  log(`Default model set to ${value}`);
  return value;
}

module.exports = {
  contextLabel,
  modelChoices,
  effortChoices,
  selectDefaultModel,
};

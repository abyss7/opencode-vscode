'use strict';

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

/** Variant ids declared by a catalogue model. */
function variantIds(model) {
  const variants = model && Array.isArray(model.variants) ? model.variants : [];
  return variants
    .map((variant) => (typeof variant === 'string' ? variant : variant && variant.id))
    .filter((id) => typeof id === 'string' && id);
}

module.exports = { modelRefString, variantIds };

'use strict';

/**
 * @file Layer 2 View: Interactive permission cards, project rule-saving UI,
 * Smart permission-classifier badges, and schema-driven elicitation forms.
 *
 * Strictly DOM-only — never writes `scrollTop` directly.
 */

const { el } = require('./dom');
const {
  toolTitle,
  toolInputObject,
  toolInputText,
  permissionPatchOperations,
  permissionPathKey,
} = require('./tool-metadata');

function permissionBusy(card, busy) {
  card.dataset.busy = busy ? '1' : '0';
  for (const control of card.querySelectorAll(
    '.permission-actions button, .permission-remember button, .permission-remember select'
  )) {
    control.disabled = busy;
  }
}

function elicitationChoices(source) {
  const choices = [];
  if (!source || typeof source !== 'object') return choices;
  const entries = Array.isArray(source.oneOf)
    ? source.oneOf
    : Array.isArray(source.anyOf)
      ? source.anyOf
      : Array.isArray(source.enum)
        ? source.enum
        : [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const value = entry.const !== undefined ? entry.const : entry.value;
      if (value === undefined || value === null) continue;
      choices.push({
        value: String(value),
        label: entry.title || entry.label || String(value),
        description: typeof entry.description === 'string' ? entry.description : '',
      });
    } else if (entry !== undefined && entry !== null) {
      choices.push({ value: String(entry), label: String(entry), description: '' });
    }
  }
  return choices;
}

function buildChoiceList(name, choices, multiple, selected) {
  const box = el('div', 'elicitation-options');
  for (const choice of choices) {
    const optionRow = el('label', 'elicitation-option');
    const input = el('input', 'elicitation-choice');
    input.type = multiple ? 'checkbox' : 'radio';
    input.value = choice.value;
    if (!multiple) input.name = 'elic-group-' + name;
    if (selected.indexOf(choice.value) !== -1) input.checked = true;
    if (multiple) {
      optionRow.appendChild(input);
    } else {
      const control = el('span', 'elicitation-radio');
      control.appendChild(input);
      optionRow.appendChild(control);
    }
    const body = el('span', 'elicitation-option-body');
    body.appendChild(el('span', 'elicitation-option-label', choice.label));
    if (choice.description) {
      body.appendChild(el('span', 'elicitation-description', choice.description));
    }
    optionRow.appendChild(body);
    box.appendChild(optionRow);
  }
  return box;
}

function elicitationRangeHint(min, max) {
  if (max !== null && min > 0) return 'Select ' + min + ' to ' + max + '.';
  if (max !== null) return 'Select up to ' + max + '.';
  return 'Select at least ' + min + '.';
}

function collectElicitationContent(controls) {
  const content = {};
  for (const name of Object.keys(controls)) {
    const value = controls[name]();
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    content[name] = value;
  }
  return content;
}

function buildElicitationField(name, prop, required, controls, limits) {
  if (!prop || typeof prop !== 'object') return null;
  const type = prop.type;
  const isRequired = required.indexOf(name) !== -1;
  const custom = name.endsWith('_custom');
  const choices =
    type === 'string'
      ? elicitationChoices(prop)
      : type === 'array'
        ? elicitationChoices(prop.items)
        : [];
  const question = choices.length > 0 && typeof prop.description === 'string' && prop.description.trim();
  const label = custom ? 'Custom answer' : question || prop.title || name;

  const row = el('div', 'elicitation-field');
  const labelEl = el(
    'label',
    question ? 'elicitation-label elicitation-question' : 'elicitation-label',
    isRequired ? label + ' *' : label
  );
  row.appendChild(labelEl);

  if (
    type === 'string' &&
    (Array.isArray(prop.enum) || Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf))
  ) {
    const selected =
      prop.default === undefined || prop.default === null ? [] : [String(prop.default)];
    const box = buildChoiceList(name, choices, false, selected);
    row.appendChild(box);
    controls[name] = () => {
      const checked = box.querySelector('input:checked');
      return checked && checked.value !== '' ? checked.value : null;
    };
  } else if (type === 'boolean') {
    const checkbox = el('input', 'elicitation-input');
    checkbox.type = 'checkbox';
    checkbox.id = 'elic-' + name;
    labelEl.setAttribute('for', checkbox.id);
    if (prop.default === true) checkbox.checked = true;
    row.appendChild(checkbox);
    controls[name] = () => checkbox.checked;
  } else if (type === 'array') {
    const items = prop.items || {};
    if (choices.length > 0) {
      const rawSelected = Array.isArray(prop.default)
        ? prop.default
        : prop.default === undefined || prop.default === null
          ? []
          : [prop.default];
      const selected = rawSelected.map((value) => String(value));
      const box = buildChoiceList(name, choices, true, selected);
      row.appendChild(box);
      controls[name] = () => {
        const picked = [];
        for (const checkbox of box.querySelectorAll('input[type="checkbox"]')) {
          if (checkbox.checked) picked.push(checkbox.value);
        }
        return picked;
      };
      const minItems = Number.isFinite(prop.minItems) && prop.minItems > 0 ? prop.minItems : 0;
      const maxItems = Number.isFinite(prop.maxItems) ? prop.maxItems : null;
      if (minItems > 0 || maxItems !== null) {
        limits[name] = { minItems, maxItems };
        row.appendChild(el('div', 'elicitation-description', elicitationRangeHint(minItems, maxItems)));
      }
    } else {
      const input = el('input', 'elicitation-input');
      input.id = 'elic-' + name;
      input.type = 'text';
      input.placeholder = 'Comma-separated values';
      labelEl.setAttribute('for', input.id);
      if (Array.isArray(prop.default) && prop.default.length > 0) {
        input.value = prop.default.join(', ');
      }
      row.appendChild(input);
      const numeric = items.type === 'number' || items.type === 'integer';
      controls[name] = () => {
        const raw = String(input.value).trim();
        if (raw === '') return [];
        return raw
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .map((item) => (numeric ? Number(item) : item))
          .filter((item) => !numeric || Number.isFinite(item));
      };
    }
  } else {
    const input = el('input', 'elicitation-input');
    input.id = 'elic-' + name;
    input.type = type === 'number' || type === 'integer' ? 'number' : 'text';
    labelEl.setAttribute('for', input.id);
    if (type === 'integer') input.step = '1';
    if (prop.minimum !== undefined) input.min = String(prop.minimum);
    if (prop.maximum !== undefined) input.max = String(prop.maximum);
    if (prop.minLength !== undefined) input.minLength = String(prop.minLength);
    if (prop.maxLength !== undefined) input.maxLength = String(prop.maxLength);
    if (prop.pattern !== undefined) input.pattern = String(prop.pattern);
    if (prop.default !== undefined && prop.default !== null) {
      input.value = String(prop.default);
    }
    row.appendChild(input);
    controls[name] = () => {
      const raw = String(input.value).trim();
      if (raw === '') return null;
      if (type === 'number' || type === 'integer') {
        const number = Number(raw);
        return Number.isFinite(number) ? number : null;
      }
      return raw;
    };
  }

  if (prop.description && !question && !custom) {
    row.appendChild(el('div', 'elicitation-description', prop.description));
  }
  return row;
}

function createPermissionsView({
  store,
  messagesEl,
  composerEl,
  questionsEl,
  richText,
  focusLocal,
  getToolCard,
  postMessage,
  onAttentionResolved,
  onQuestionsChanged,
}) {
  const attentionTargets = new Map();
  const smartReviewNodes = new Map();
  let smartReviewHistory = null;

  function renderPermissionDetails(card, toolCall) {
    const update = toolCall || {};
    const input = toolInputObject(update);
    const content = Array.isArray(update.content) ? update.content : [];
    const diffs = content.filter((item) => item?.type === 'diff' && typeof item.newText === 'string');
    const operation = {
      read: 'Read files',
      edit: 'Edit files',
      delete: 'Delete files',
      move: 'Move files',
      search: 'Search',
      execute: 'Run command',
      fetch: 'Fetch URL',
    }[update.kind];
    if (operation || update.name) {
      card.appendChild(
        el('div', 'permission-operation', [operation, update.name].filter(Boolean).join(' · '))
      );
    }

    const files = new Map();
    for (const location of Array.isArray(update.locations) ? update.locations : []) {
      if (typeof location?.path === 'string') files.set(location.path, { line: location.line });
    }
    for (const diff of diffs) {
      if (typeof diff.path !== 'string') continue;
      const info = files.get(diff.path) || {};
      files.set(diff.path, {
        ...info,
        diffs: [...(info.diffs || []), diff],
        action: diff.oldText === null ? 'Create' : diff.newText === '' ? 'Remove contents' : 'Change',
      });
    }
    const inputPath = input?.filePath || input?.path;
    if (!files.size && typeof inputPath === 'string') files.set(inputPath, {});

    const cwd = store.state.cwd || '';
    const findPath = (value) =>
      [...files.keys()].find((file) => permissionPathKey(file, cwd) === permissionPathKey(value, cwd));
    for (const op of permissionPatchOperations(input)) {
      const source = findPath(op.path);
      const target = op.to ? findPath(op.to) : source;
      if (!target) continue;
      const info = files.get(target);
      if (op.to) {
        const previous = source && source !== target ? files.get(source) : null;
        files.set(target, {
          ...info,
          from: source || op.path,
          action: 'Rename',
          diffs: [...(previous?.diffs || []), ...(info.diffs || [])],
        });
        if (source && source !== target) files.delete(source);
      } else {
        files.set(target, { ...info, action: op.action });
      }
    }

    if (files.size) {
      const list = el('ul', 'permission-files');
      for (const [path, info] of files) {
        const item = el('li');
        const line = Number(info.line) || null;
        const label = info.from ? `${info.from} → ${path}` : line ? `${path}:${line}` : path;
        const link = el(
          'span',
          'file-ref',
          info.diffs?.length ? (info.from ? 'Open source file' : 'Open file') : label
        );
        link.dataset.file = info.from || path;
        if (line) link.dataset.line = String(line);
        if (info.diffs?.length) {
          const details = el('details', 'permission-file');
          details.open = files.size === 1;
          const summary = el('summary');
          if (info.action) summary.appendChild(el('span', 'permission-file-action', info.action + ' · '));
          summary.appendChild(el('span', 'permission-file-path', label));
          const preview = el('div', 'permission-preview');
          richText.renderToolResult(preview, { content: info.diffs }, postMessage);
          const toolbar = preview.querySelector('.result-toolbar');
          if (toolbar) toolbar.prepend(link);
          details.append(summary, preview);
          item.appendChild(details);
        } else {
          if (info.action) item.appendChild(el('span', 'permission-file-action', info.action + ' · '));
          item.appendChild(link);
        }
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    if (typeof input?.command === 'string') {
      card.appendChild(el('pre', 'permission-command', input.command));
      const workdir = input.workdir || input.cwd;
      if (typeof workdir === 'string') {
        card.appendChild(el('div', 'permission-directory', 'Working directory: ' + workdir));
      }
    }
    const otherContent = content.filter((item) => !diffs.includes(item) || typeof item.path !== 'string');
    if (otherContent.length) {
      const preview = el('div', 'permission-preview');
      richText.renderToolResult(preview, { content: otherContent }, postMessage);
      card.appendChild(preview);
    }
    if (!diffs.length && (['edit', 'delete', 'move'].includes(update.kind) || (!content.length && !input))) {
      card.appendChild(el('div', 'permission-note', 'No change preview was provided by OpenCode.'));
    }
    const raw = toolInputText(update);
    if (raw) {
      const details = el('details', 'permission-input');
      details.open = !content.length && typeof input?.command !== 'string';
      details.appendChild(el('summary', '', 'Operation arguments'));
      details.appendChild(el('pre', '', raw));
      card.appendChild(details);
    }
  }

  function renderRememberRule(card, message) {
    let holder = card.querySelector('.permission-remember');
    if (!holder) {
      holder = el('div', 'permission-remember');
      card.appendChild(holder);
    }
    holder.replaceChildren();
    const policy = message.policy;
    if (!policy) return;
    if (!policy.choices?.length) {
      holder.appendChild(el('div', 'permission-note', 'No precise saved rule is available for this request.'));
      return;
    }
    const details = el('details');
    details.appendChild(el('summary', '', 'Save rule…'));
    details.appendChild(el('div', 'permission-note', `All sessions in this project · ${policy.profileLabel}`));
    const choice = document.createElement('select');
    choice.setAttribute('aria-label', 'Rule target');
    for (const item of policy.choices) {
      const option = el('option', '', item.label);
      option.value = item.id;
      choice.appendChild(option);
    }
    const effect = document.createElement('select');
    effect.setAttribute('aria-label', 'Rule decision');
    for (const [value, label] of [['allow', 'Allow'], ['deny', 'Forbid']]) {
      const option = el('option', '', label);
      option.value = value;
      effect.appendChild(option);
    }
    const preview = el('pre', 'permission-rule-preview');
    const update = () => {
      const selected = policy.choices.find((item) => item.id === choice.value);
      preview.textContent = (selected?.rules || [])
        .map(
          (rule) =>
            `${effect.value === 'allow' ? 'Allow' : 'Forbid'} ${rule.action} · ${rule.resource} (${rule.match || 'glob'})`
        )
        .join('\n');
    };
    choice.addEventListener('change', update);
    effect.addEventListener('change', update);
    update();
    const save = el('button', '', 'Save and apply');
    save.addEventListener('click', () => {
      if (card.dataset.resolved === '1' || card.dataset.busy === '1') return;
      card.querySelector('.permission-save-status')?.remove();
      permissionBusy(card, true);
      postMessage({
        type: 'savePermissionRule',
        requestId: message.requestId,
        choiceId: choice.value,
        effect: effect.value,
      });
    });
    details.append(effect, choice, preview, save);
    holder.appendChild(details);
  }

  function renderPermissionCard(message, attentionKey) {
    for (const existing of messagesEl.querySelectorAll('.permission[data-request-id]')) {
      if (existing.dataset.requestId !== String(message.requestId)) continue;
      existing.remove();
    }
    const card = el('div', 'permission');
    card.dataset.requestId = String(message.requestId);
    card.dataset.anchorId = `permission:${message.requestId}`;
    card.appendChild(el('div', 'permission-title', 'Permission required'));
    if (message.policy?.reason) card.appendChild(el('div', 'permission-reason', message.policy.reason));
    card.appendChild(el('div', 'permission-tool', toolTitle(message.toolCall)));
    renderPermissionDetails(card, message.toolCall);

    const actions = el('div', 'permission-actions');
    const options = Array.isArray(message.options) ? message.options : [];
    for (const option of options) {
      const allow =
        /^(allow|approve)/i.test(String(option.kind || '')) ||
        /allow|approve/i.test(String(option.name || ''));
      const button = el('button', allow ? 'allow' : 'reject', option.name || option.optionId);
      button.addEventListener('click', () => {
        if (card.dataset.resolved === '1' || card.dataset.busy === '1') return;
        card.dataset.resolved = '1';
        permissionBusy(card, true);
        attentionTargets.delete(attentionKey);
        onAttentionResolved?.(attentionKey);
        card.appendChild(el('div', 'permission-note', 'Selected: ' + (option.name || option.optionId)));
        postMessage({
          type: 'permissionResponse',
          requestId: message.requestId,
          optionId: option.optionId,
        });
      });
      actions.appendChild(button);
    }

    if (options.length === 0) {
      const button = el('button', 'reject', 'Cancel');
      button.addEventListener('click', () => {
        if (card.dataset.resolved === '1' || card.dataset.busy === '1') return;
        card.dataset.resolved = '1';
        permissionBusy(card, true);
        attentionTargets.delete(attentionKey);
        onAttentionResolved?.(attentionKey);
        card.appendChild(el('div', 'permission-note', 'Cancelled'));
        postMessage({
          type: 'permissionResponse',
          requestId: message.requestId,
          optionId: null,
        });
      });
      actions.appendChild(button);
    }

    card.appendChild(actions);
    renderRememberRule(card, message);
    messagesEl.appendChild(card);
    attentionTargets.set(attentionKey, card);
    return card;
  }

  function applyPermissionRuleResult(message) {
    const card = [...messagesEl.querySelectorAll('.permission[data-request-id]')].find(
      (item) => item.dataset.requestId === String(message.requestId)
    );
    if (!card || card.dataset.resolved === '1') return;
    card.querySelector('.permission-save-status')?.remove();
    if (message.error) {
      if (message.policy) {
        renderRememberRule(card, message);
        const reason = card.querySelector('.permission-reason');
        if (reason) reason.textContent = message.policy.reason;
      }
      permissionBusy(card, false);
    } else {
      card.dataset.resolved = '1';
      permissionBusy(card, true);
      attentionTargets.delete(`permission:${message.requestId}`);
    }
    const status = el('div', 'permission-note permission-save-status', message.error || message.note);
    status.setAttribute('role', message.error ? 'alert' : 'status');
    card.appendChild(status);
  }

  function smartReviewTool(review) {
    if (typeof review.toolCallId !== 'string' || !review.toolCallId) return null;
    if (!review.sessionID) return getToolCard(review.toolCallId);
    const prefix = review.sessionID + ':';
    const id = review.toolCallId.startsWith(prefix)
      ? review.toolCallId.slice(prefix.length)
      : review.toolCallId;
    return (
      getToolCard(prefix + id) ||
      (review.sessionID === store.state.sessionId ? getToolCard(id) : null)
    );
  }

  function placeSmartReview(record) {
    const tool = smartReviewTool(record.review);
    if (tool) {
      for (const other of smartReviewNodes.values()) {
        if (other === record || smartReviewTool(other.review) !== tool) continue;
        if (
          (record.review.restored && !other.review.restored && other.review.status === 'deny') ||
          (record.review.status === 'reviewing' && other.review.restored)
        ) {
          record.card.remove();
          return;
        }
        if (
          (record.review.restored && other.review.status === 'reviewing') ||
          (!record.review.restored && record.review.status === 'deny' && other.review.restored)
        ) {
          other.card.remove();
        }
      }
      if (record.card.parentElement !== tool.entry) tool.entry.insertBefore(record.card, tool.body);
      if (smartReviewHistory && !smartReviewHistory.body.children.length) {
        smartReviewHistory.details.remove();
        smartReviewHistory = null;
      }
      return;
    }
    if (record.review.restored) {
      record.card.remove();
      return;
    }
    if (!smartReviewHistory) {
      const details = el('details', 'smart-review-history');
      details.dataset.anchorId = 'smart-review-history';
      details.appendChild(el('summary', '', 'Unlinked Smart permissions'));
      const body = el('div', 'body');
      details.appendChild(body);
      messagesEl.appendChild(details);
      smartReviewHistory = { details, body };
    }
    if (record.card.parentElement !== smartReviewHistory.body) {
      smartReviewHistory.body.appendChild(record.card);
    }
  }

  function upsertSmartReview(review, unchanged = false) {
    if (!review || !review.id) return;
    const previous = smartReviewNodes.get(review.id);
    if (unchanged && previous) {
      placeSmartReview(previous);
      return;
    }
    const card = previous?.card || el('div', 'permission smart-review');
    card.dataset.reviewId = review.id;
    card.setAttribute('role', 'status');
    card.dataset.status = review.status;
    card.replaceChildren();
    const status = { reviewing: 'Reviewing', allow: 'Allowed', deny: 'Blocked' }[review.status] || 'Blocked';
    card.appendChild(
      el(
        'div',
        'permission-title',
        review.restored ? `Permissions · ${status}` : `Smart · ${status} · permission-classifier`
      )
    );
    card.appendChild(
      el('div', 'permission-tool', review.restored ? review.resource : `${review.action}: ${review.resource}`)
    );
    if (review.reason) card.appendChild(el('div', 'permission-note', review.reason));
    card.title = review.model ? `Reviewer model: ${review.model}` : '';
    const record = { card, review };
    smartReviewNodes.set(review.id, record);
    placeSmartReview(record);
  }

  function restorePermissionRejection(toolCard) {
    const error = toolCard.activity.rawOutput?.error;
    const match = typeof error === 'string' && /^VS Code permissions: deny(?: — ([\s\S]*))?$/.exec(error);
    if (toolCard.statusValue !== 'failed' || !match) return;
    const review = {
      id: `restored:${store.state.sessionId}:${toolCard.activity.toolCallId}`,
      sessionID: store.state.sessionId,
      toolCallId: toolCard.activity.toolCallId,
      restored: true,
      status: 'deny',
      resource: toolCard.nameEl.textContent,
      reason: match[1] || error,
    };
    const prev = store.state.smartReviews.get(review.id);
    const sig = JSON.stringify(review);
    store.state.smartReviews.set(review.id, { id: review.id, signature: sig, review });
    upsertSmartReview(review, prev?.signature === sig);
  }

  function reattachForTool(toolCard) {
    for (const record of smartReviewNodes.values()) {
      if (smartReviewTool(record.review) === toolCard) placeSmartReview(record);
    }
  }

  function resetForReplay() {
    smartReviewHistory = null;
    for (const [key] of attentionTargets) {
      if (String(key).startsWith('permission:')) attentionTargets.delete(key);
    }
    for (const record of smartReviewNodes.values()) placeSmartReview(record);
  }

  function clearSmartReviews() {
    for (const record of smartReviewNodes.values()) record.card.remove();
    smartReviewNodes.clear();
    smartReviewHistory?.details.remove();
    smartReviewHistory = null;
  }

  function syncQuestions() {
    if (!questionsEl) return;
    const cards = [...questionsEl.querySelectorAll('.elicitation')];
    cards.forEach((card, index) => { card.hidden = index !== 0; });
    questionsEl.hidden = cards.length === 0;
    composerEl?.classList.toggle('question-active', cards.length > 0);
    onQuestionsChanged?.();
  }

  function clearQuestions() {
    if (!questionsEl) return;
    for (const [key] of attentionTargets) {
      if (String(key).startsWith('elicitation:')) attentionTargets.delete(key);
    }
    questionsEl.replaceChildren();
    syncQuestions();
  }

  function renderElicitation(message, attentionKey) {
    if (store.state.archived || !questionsEl) return;
    for (const existing of questionsEl.querySelectorAll('.elicitation[data-request-id]')) {
      if (existing.dataset.requestId !== String(message.requestId)) continue;
      existing.remove();
    }

    const schema = message.requestedSchema || {};
    const properties = (schema && schema.properties) || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const controls = {};
    const limits = {};

    const card = el('div', 'elicitation');
    card.dataset.requestId = String(message.requestId);
    if (typeof message.message === 'string' && message.message && !/^questions?$/i.test(message.message.trim())) {
      card.appendChild(el('div', 'elicitation-message', message.message));
    }

    const form = el('div', 'elicitation-form');
    for (const name of Object.keys(properties)) {
      const field = buildElicitationField(name, properties[name], required, controls, limits);
      if (field) form.appendChild(field);
    }
    card.appendChild(form);

    const actions = el('div', 'permission-actions');
    const submit = el('button', 'allow', 'Submit');
    const cancel = el('button', 'reject', 'Decline');
    const feedback = el('div', 'permission-note');

    const note = (text) => {
      feedback.textContent = text;
      if (feedback.parentNode !== card) card.appendChild(feedback);
    };

    function resolve(action) {
      if (card.dataset.resolved === '1') return;
      card.dataset.resolved = '1';
      attentionTargets.delete(attentionKey);
      onAttentionResolved?.(attentionKey);
      const payload = { type: 'elicitationResponse', requestId: message.requestId, action };
      if (action === 'accept') payload.content = collectElicitationContent(controls);
      postMessage(payload);
      card.remove();
      syncQuestions();
    }

    submit.addEventListener('click', () => {
      const missing = required.filter((name) => {
        const value = controls[name] ? controls[name]() : null;
        return (
          value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0)
        );
      });
      if (missing.length > 0) {
        note('Please fill in all required fields.');
        return;
      }
      for (const name of Object.keys(limits)) {
        const value = controls[name] ? controls[name]() : null;
        const count = Array.isArray(value) ? value.length : 0;
        const limit = limits[name] || {};
        const label = properties[name] && properties[name].title ? properties[name].title : name;
        if (Number.isFinite(limit.minItems) && count < limit.minItems) {
          note('Select at least ' + limit.minItems + ' option(s) for "' + label + '".');
          return;
        }
        if (Number.isFinite(limit.maxItems) && count > limit.maxItems) {
          note('Select at most ' + limit.maxItems + ' option(s) for "' + label + '".');
          return;
        }
      }
      resolve('accept');
    });
    cancel.addEventListener('click', () => resolve('decline'));

    actions.appendChild(submit);
    actions.appendChild(cancel);
    card.appendChild(actions);
    questionsEl.appendChild(card);
    attentionTargets.set(attentionKey, card);
    syncQuestions();
    if (!card.hidden) {
      focusLocal(card.querySelector('input, button.allow'), questionsEl);
    }
  }

  function removeResolvedRequest(requestId) {
    attentionTargets.delete(`permission:${requestId}`);
    attentionTargets.delete(`elicitation:${requestId}`);
    for (const card of [
      ...messagesEl.querySelectorAll('.permission[data-request-id]'),
      ...(questionsEl ? questionsEl.querySelectorAll('.elicitation[data-request-id]') : []),
    ]) {
      if (card.dataset.requestId === String(requestId)) card.remove();
    }
    syncQuestions();
  }

  return {
    renderPermissionCard,
    applyPermissionRuleResult,
    upsertSmartReview,
    restorePermissionRejection,
    reattachForTool,
    resetForReplay,
    clearSmartReviews,
    renderElicitation,
    syncQuestions,
    clearQuestions,
    removeResolvedRequest,
    getAttentionTarget: (key) => attentionTargets.get(key) || null,
  };
}

module.exports = { createPermissionsView };

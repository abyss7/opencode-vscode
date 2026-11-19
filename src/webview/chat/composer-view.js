'use strict';

/**
 * @file Layer 2 View: Composer input, attachments, artifact selection chip,
 * slash/skill completion menu, and session settings bar (Agent label, Model
 * picker, Effort slider, Permission profile & fallback selectors).
 *
 * Strictly DOM-only — never touches transcript scroll state directly.
 */

const { el } = require('./dom');

function isAgentOption(option) {
  return Boolean(option) && (option.id === 'mode' || option.id === 'agent' || option.category === 'mode');
}

function createComposerView({
  store,
  composerEl,
  composerControls,
  questionsEl,
  inputEl,
  sendBtn,
  stopBtn,
  attachmentsEl,
  selectionChipEl,
  slashMenuEl,
  configBarEl,
  agentLabelEl,
  focusLocal,
  modelPickerFactory,
  postMessage,
  onSend,
  onStop,
  onInfo,
  onStateChanged,
}) {
  let modelPicker = null;
  let permissionPicker = null;
  let draftInitialized = false;
  let draftText = '';

  function saveDraft() {
    draftInitialized = true;
    if (draftText === inputEl.value) return;
    draftText = inputEl.value;
    postMessage({ type: 'saveDraft', text: draftText });
  }

  function restoreDraft(text) {
    // A delayed or repeated handshake must not replace local edits.
    if (draftInitialized || typeof text !== 'string') return;
    draftInitialized = true;
    draftText = text;
    if (!text) return;
    inputEl.value = text;
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    resizeInput();
    updateComposer();
  }

  function updateComposer() {
    const { state } = store;
    if (composerEl) composerEl.hidden = state.archived;
    const canType = state.connected && !state.archived;
    const hasImages = state.images.length + state.selectionImages.length > 0;
    inputEl.disabled = !canType;
    inputEl.placeholder = !canType
      ? state.statusKind === 'connecting'
        ? 'Connecting…'
        : 'Disconnected'
      : state.busy
        ? 'OpenCode is working — type to queue…'
        : state.statusKind === 'unconfirmed'
          ? 'Send a message to continue…'
          : 'Ask OpenCode…';
    sendBtn.disabled =
      !canType ||
      (state.busy && hasImages) ||
      (inputEl.value.trim() === '' && !hasImages);
    const showStop = state.busy && inputEl.value.trim() === '' && !hasImages;
    sendBtn.hidden = showStop;
    stopBtn.hidden = !showStop;
    stopBtn.disabled = state.statusKind === 'cancelling';
    if (!canType) closeSlashMenu();
  }

  function resizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  function clearInput() {
    inputEl.value = '';
    saveDraft();
    resizeInput();
  }

  function unseenImageNotice() {
    onInfo?.(
      'The current model cannot see images; attachments are kept in the session and will be used after switching to a vision model.'
    );
  }

  function renderAttachments() {
    const { state } = store;
    attachmentsEl.replaceChildren();
    attachmentsEl.hidden = state.images.length === 0;
    for (const image of state.images) {
      const chip = el('div', 'attachment');
      const unseen = !state.imageSupport;
      if (unseen) chip.classList.add('attachment-unseen');
      const thumb = document.createElement('img');
      thumb.src = image.dataUrl;
      thumb.alt = image.name || 'image';
      thumb.title = unseen
        ? `${image.name || 'image'} — the current model cannot see this image`
        : image.name || 'image';
      const remove = el('button', 'attachment-remove', '×');
      remove.type = 'button';
      remove.title = 'Remove image';
      remove.setAttribute('aria-label', 'Remove image');
      remove.addEventListener('click', () => {
        state.images = state.images.filter((item) => item.id !== image.id);
        renderAttachments();
        updateComposer();
      });
      chip.appendChild(thumb);
      chip.appendChild(remove);
      attachmentsEl.appendChild(chip);
    }
  }

  function renderSelection() {
    if (!selectionChipEl) return;
    const { selection, selectionImages } = store.state;
    selectionChipEl.replaceChildren();
    selectionChipEl.hidden = !selection;
    if (!selection) return;
    selectionChipEl.appendChild(
      el('span', '', `${selection.artifact.title} · v${selection.artifact.version} · ${selection.selection.type}`)
    );
    const clear = el('button', '', 'Remove selection');
    clear.type = 'button';
    clear.addEventListener('click', () => selectContext(null));
    selectionChipEl.appendChild(clear);
    selectionChipEl.title = JSON.stringify(selection.selection, null, 2);
    for (const image of selectionImages) {
      const thumb = el('img');
      thumb.src = image.dataUrl;
      thumb.alt = image.name;
      selectionChipEl.appendChild(thumb);
    }
  }

  function selectContext(context, images = []) {
    const { state } = store;
    if (state.archived && context) return;
    state.selection = context;
    state.selectionImages = images;
    if (images.length > 0 && !state.imageSupport) unseenImageNotice();
    renderSelection();
    updateComposer();
    focusLocal(inputEl, composerControls);
  }

  function addImageFiles(files) {
    const maxBytes = 10 * 1024 * 1024;
    for (const file of files) {
      if (!file || !file.type || !file.type.startsWith('image/')) continue;
      if (file.size > maxBytes) {
        onInfo?.(`Image is too large (${Math.round(file.size / 1024 / 1024)} MB).`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return;
        store.state.images.push({
          id: store.state.nextImageId++,
          name: file.name || 'pasted-image',
          mimeType: file.type || 'image/png',
          data: dataUrl.slice(comma + 1),
          dataUrl,
        });
        renderAttachments();
        updateComposer();
        onStateChanged?.();
      };
      reader.onerror = () => onInfo?.('Failed to read the pasted image.');
      reader.readAsDataURL(file);
    }
  }

  function currentSlashQuery() {
    return store.slashQuery(inputEl.value, inputEl.selectionStart, inputEl.selectionEnd);
  }

  function closeSlashMenu() {
    slashMenuEl.hidden = true;
    store.state.slashOpen = false;
    store.state.slashIndex = 0;
  }

  function renderSlashMenu(items) {
    slashMenuEl.replaceChildren();
    const limit = Math.min(items.length, 12);
    if (limit === 0) {
      closeSlashMenu();
      return;
    }
    if (store.state.slashIndex >= limit) store.state.slashIndex = 0;
    for (let index = 0; index < limit; index += 1) {
      const item = items[index];
      const row = el('button', 'slash-item');
      row.type = 'button';
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.classList.toggle('selected', index === store.state.slashIndex);
      row.appendChild(el('span', 'slash-kind', item.kind === 'skill' ? 'skill' : 'cmd'));
      row.appendChild(el('span', 'slash-name', item.kind === 'skill' ? '@' + item.name : '/' + item.name));
      const description = el('span', 'slash-desc', item.description || '');
      description.title = item.description || '';
      row.appendChild(description);
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => selectSlashItem(index));
      slashMenuEl.appendChild(row);
    }
    slashMenuEl.hidden = false;
    store.state.slashOpen = true;
  }

  function refreshSlashMenu() {
    const query = currentSlashQuery();
    if (query === null || !store.state.connected) {
      closeSlashMenu();
      return;
    }
    store.buildSlashItems();
    slashMenuEl.setAttribute('aria-label', query.kind === 'skill' ? 'Skills' : 'Commands');
    renderSlashMenu(store.filteredSlashItems(query));
  }

  function moveSlashSelection(delta) {
    if (!store.state.slashOpen) return;
    const items = store.filteredSlashItems(currentSlashQuery());
    if (items.length === 0) return;
    const size = Math.min(items.length, 12);
    store.state.slashIndex = (store.state.slashIndex + delta + size) % size;
    renderSlashMenu(items);
  }

  function selectSlashItem(index) {
    const query = currentSlashQuery();
    const items = store.filteredSlashItems(query);
    const item = items[index];
    if (!item) return;
    const suffix = inputEl.value.slice(query.end);
    const insert = /^\s/.test(suffix) ? item.insert.trimEnd() : item.insert;
    const before = inputEl.value;
    focusLocal(inputEl, composerControls);
    inputEl.setSelectionRange(query.start, query.end);
    // Unlike assigning .value or setRangeText, insertText joins the textarea's
    // native undo history as an edit, including the replaced text and selection.
    if (!document.execCommand?.('insertText', false, insert)) {
      inputEl.value = before.slice(0, query.start) + insert + suffix;
      const position = query.start + insert.length;
      inputEl.setSelectionRange(position, position);
      saveDraft();
      resizeInput();
      updateComposer();
    }
    closeSlashMenu();
  }

  function appendFixedAgent(option) {
    if (!agentLabelEl) return;
    agentLabelEl.title = 'Agent fixed at session creation. Choose the agent for new sessions in the sidebar.';
    const selected = (option.options || []).find((item) => item.value === option.currentValue);
    agentLabelEl.textContent = `Agent: ${selected?.name || option.currentValue || '—'}`;
    agentLabelEl.hidden = false;
  }

  function appendEffortSlider(option, target = configBarEl) {
    if (option.options.length < 2) return null;
    const choices = [
      ...option.options.filter((item) => item.value === 'default'),
      ...option.options.filter((item) => item.value !== 'default'),
    ];
    const label = el('label', 'config effort-control');
    label.appendChild(el('span', null, option.name || 'Effort'));
    const valueLabel = target !== configBarEl ? el('span', 'effort-value') : null;
    if (valueLabel) label.appendChild(valueLabel);
    const track = el('span', 'effort-track');
    const ticks = el('span', 'effort-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    for (const item of choices) {
      ticks.appendChild(el('span', item.value === 'default' ? 'effort-default-tick' : ''));
    }
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(choices.length - 1);
    input.step = '1';
    input.value = String(Math.max(0, choices.findIndex((item) => item.value === option.currentValue)));
    input.dataset.configId = option.id;
    input.setAttribute('aria-label', option.name || 'Effort');
    const tooltip = el('span', 'effort-tooltip');
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    let dragging = false;
    let pending = false;
    const initial = input.value;
    const selected = () => choices[Number(input.value)];
    const update = () => {
      const name = selected().name || selected().value;
      input.setAttribute('aria-valuetext', name);
      if (valueLabel) valueLabel.textContent = name;
    };
    const show = (index = Number(input.value)) => {
      const item = choices[index];
      tooltip.textContent = item.value === 'default' ? 'Default — model setting' : item.name || item.value;
      tooltip.hidden = false;
      const rect = input.getBoundingClientRect();
      const width = tooltip.getBoundingClientRect().width;
      const center = rect.left + 6 + ((rect.width - 12) * index) / (choices.length - 1);
      tooltip.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, center - width / 2))}px`;
      tooltip.style.top = `${Math.max(4, rect.top - tooltip.offsetHeight - 6)}px`;
    };
    const hide = () => { tooltip.hidden = true; };
    input.addEventListener('pointerdown', (event) => {
      if (pending) { event.preventDefault(); return; }
      if (event.button !== 0) return;
      dragging = true;
      input.setPointerCapture(event.pointerId);
      show();
    });
    input.addEventListener('pointermove', (event) => {
      if (dragging) { show(); return; }
      const rect = input.getBoundingClientRect();
      const index = Math.round(((event.clientX - rect.left - 6) / (rect.width - 12)) * (choices.length - 1));
      show(Math.max(0, Math.min(choices.length - 1, index)));
    });
    input.addEventListener('pointerup', () => {
      dragging = false;
      if (!input.matches(':hover')) hide();
    });
    input.addEventListener('pointercancel', () => {
      dragging = false;
      input.value = initial;
      update();
      hide();
    });
    input.addEventListener('pointerleave', () => { if (!dragging) hide(); });
    input.addEventListener('focus', () => show());
    input.addEventListener('blur', hide);
    input.addEventListener('keydown', (event) => {
      if (pending && event.key !== 'Tab') event.preventDefault();
    });
    input.addEventListener('input', () => { update(); show(); });
    input.addEventListener('change', () => {
      if (pending || input.value === initial) return;
      pending = true;
      input.setAttribute('aria-disabled', 'true');
      postMessage({ type: 'setConfigOption', configId: option.id, value: selected().value });
    });
    update();
    track.append(ticks, input, tooltip);
    label.appendChild(track);
    target.appendChild(label);
    return label;
  }

  function appendPermissionProfiles() {
    const current = store.state.permissionProfile;
    const pickerApi = modelPickerFactory();
    if (!current || !pickerApi) return;
    permissionPicker = pickerApi.createMenu({ label: 'Permissions', className: 'permission-picker' });
    const { panel, button } = permissionPicker;
    const fallbackChoices = [
      { id: 'forbid', label: 'Forbid' },
      { id: 'ask', label: 'Ask' },
      { id: 'smart', label: 'Smart' },
      { id: 'permit', label: 'Permit' },
    ];
    const profileName = current.profiles.find((item) => item.id === current.selected)?.label || current.selected;
    const summaryName = current.selected === 'all' && profileName === 'All ⚠' ? 'All' : profileName;
    const fallbackName = fallbackChoices.find((item) => item.id === current.newActions)?.label || current.newActions;
    const warning = ['host', 'all'].includes(current.selected) || current.newActions === 'permit';
    button.append(
      el('span', 'model-name', summaryName),
      el('span', 'settings-separator', '·'),
      el('span', 'permission-fallback', fallbackName),
      pickerApi.chevron()
    );
    button.title = `Permissions: ${summaryName} · ${fallbackName}${current.inherited ? ' · Inherited from parent' : ''}`;
    button.setAttribute('aria-description', button.title);
    panel.appendChild(el('div', 'session-settings-heading', 'Permissions'));
    if (warning) {
      panel.appendChild(
        el(
          'div',
          'session-settings-note permission-note permission-access-warning',
          ['host', 'all'].includes(current.selected)
            ? '⚠ Broad access: this profile permits all actions unless explicit rules restrict them.'
            : '⚠ Permit allows actions without a matching rule. Explicit restrictions still apply.'
        )
      );
    }
    const makeSelect = (caption, choices, value, field, disabled) => {
      const label = el('label', 'config permission-field');
      label.appendChild(el('span', null, caption));
      const select = document.createElement('select');
      select.setAttribute('aria-label', caption);
      select.dataset.permissionField = field;
      for (const item of choices) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        if (
          ((field === 'profile' && ['host', 'all'].includes(item.id)) ||
            (field === 'newActions' && item.id === 'permit')) &&
          !item.label.includes('⚠')
        ) {
          option.textContent += ' ⚠';
        }
        option.selected = item.id === value;
        select.appendChild(option);
      }
      select.disabled = disabled || current.inherited;
      select.addEventListener('change', () => {
        permissionPicker.pendingField = field;
        permissionPicker.pendingFocus = permissionPicker.containsFocus();
        for (const control of configBarEl.querySelectorAll('.permission-control')) control.disabled = true;
        postMessage({ type: 'setPermissionProfile', [field]: select.value });
      });
      select.className = 'permission-control';
      label.appendChild(select);
      panel.appendChild(label);
      return select;
    };
    const profile = makeSelect('Profile', current.profiles, current.selected, 'profile', false);
    profile.title =
      `Layers: ${(current.layers || []).join(' → ')}. Explicit denies remain in force.` +
      (current.selected === 'host'
        ? ' Host currently has the same access as All; it does not isolate the network.'
        : '');
    const fallback = makeSelect('Without a rule', fallbackChoices, current.newActions, 'newActions', current.fallbackLocked);
    fallback.title = current.fallbackLocked
      ? 'This profile already has a rule for every action.'
      : 'Only actions not matched by any profile rule. Saved for this session and profile.';
    panel.appendChild(
      el(
        'div',
        'session-settings-note permission-note',
        current.fallbackLocked
          ? 'This profile already has a rule for every action.'
          : 'Only actions not covered by a rule. Explicit rules take precedence.'
      )
    );
    const rules = el('button', 'permission-rules-link', 'Rules…');
    rules.title = current.rulesFile || 'Open project permission rules';
    rules.setAttribute('aria-label', 'Open permission rules');
    rules.addEventListener('click', () => {
      permissionPicker.close();
      permissionPicker.focus();
      postMessage({ type: 'openPermissionRules' });
    });
    panel.appendChild(rules);
    if (current.inherited) {
      panel.appendChild(el('div', 'session-settings-note permission-note', 'Inherited from parent'));
    }
    configBarEl.appendChild(permissionPicker.element);
  }

  function renderConfigOptions() {
    const options = store.state.configOptions || [];
    const pickerApi = modelPickerFactory();
    const restoreModelFocus = modelPicker?.containsFocus();
    const restoreEffortFocus =
      configBarEl.contains(document.activeElement) && document.activeElement?.matches?.('input[type="range"]')
        ? document.activeElement.dataset.configId
        : null;
    const permissionWasOpen = permissionPicker && !permissionPicker.panel.hidden;
    const permissionField =
      permissionPicker?.pendingField ||
      (permissionPicker?.containsFocus() ? document.activeElement?.dataset?.permissionField : null);
    const restorePermissionFocus = permissionPicker?.containsFocus() || permissionPicker?.pendingFocus;
    const modelSearch =
      modelPicker?.containsFocus() && document.activeElement?.matches?.('.model-picker-search')
        ? document.activeElement.value
        : null;

    modelPicker?.dispose();
    modelPicker = null;
    permissionPicker?.dispose();
    permissionPicker = null;
    configBarEl.replaceChildren();
    if (agentLabelEl) agentLabelEl.hidden = true;

    const list = Array.isArray(options) ? options : [];
    const modelOption = list.find(
      (option) =>
        option?.type === 'select' &&
        Array.isArray(option.options) &&
        (option.category === 'model' || option.id === 'model')
    );
    const effortOption = list.find(
      (option) =>
        option?.type === 'select' &&
        Array.isArray(option.options) &&
        (option.id === 'effort' || option.category === 'thought_level')
    );

    for (const option of list) {
      if (!option) continue;
      if (isAgentOption(option)) {
        appendFixedAgent(option);
        continue;
      }
      if (option.type !== 'select' || !Array.isArray(option.options)) continue;
      if ((option.category === 'model' || option.id === 'model') && pickerApi) {
        const effortContainer = document.createElement('div');
        const effort = effortOption ? appendEffortSlider(effortOption, effortContainer) : null;
        const selectedEffort = effortOption?.options.find((item) => item.value === effortOption.currentValue);
        modelPicker = pickerApi.create(
          option,
          (value) => postMessage({ type: 'setConfigOption', configId: option.id, value }),
          { effort, effortLabel: selectedEffort?.name || selectedEffort?.value }
        );
        configBarEl.appendChild(modelPicker.element);
        continue;
      }
      if (option.id === 'effort' || option.category === 'thought_level') {
        if (!modelOption) appendEffortSlider(option);
        continue;
      }
      const label = el('label', 'config');
      label.appendChild(el('span', null, option.name || option.id));
      const select = document.createElement('select');
      if (option.description) select.title = option.description;
      for (const item of option.options) {
        const choice = document.createElement('option');
        choice.value = item.value;
        choice.textContent = item.name || item.value;
        if (item.description) choice.title = item.description;
        if (item.value === option.currentValue) choice.selected = true;
        select.appendChild(choice);
      }
      select.addEventListener('change', () => {
        select.disabled = true;
        postMessage({ type: 'setConfigOption', configId: option.id, value: select.value });
      });
      label.appendChild(select);
      configBarEl.appendChild(label);
    }

    appendPermissionProfiles();
    configBarEl.hidden = configBarEl.children.length === 0;

    if (restoreModelFocus) modelPicker?.focus();
    if (restoreEffortFocus) {
      modelPicker?.open();
      focusLocal(
        [...configBarEl.querySelectorAll('input[type="range"]')].find(
          (input) => input.dataset.configId === restoreEffortFocus
        ),
        composerControls
      );
    }
    if (modelSearch !== null && modelPicker) {
      modelPicker.open();
      const search = modelPicker.panel.querySelector('.model-picker-search');
      search.value = modelSearch;
      search.dispatchEvent(new Event('input'));
      focusLocal(search, composerControls);
    }
    if (permissionWasOpen && permissionPicker) {
      permissionPicker.open();
      if (restorePermissionFocus) {
        const field = [...permissionPicker.panel.querySelectorAll('select')].find(
          (select) => select.dataset.permissionField === permissionField && !select.disabled
        );
        focusLocal(field || permissionPicker.button, composerControls);
      }
    }
  }

  function focusComposerInput() {
    if (store.state.archived) return;
    if (questionsEl && !questionsEl.hidden) {
      focusLocal(
        questionsEl.querySelector('.elicitation:not([hidden]) button.allow, .elicitation:not([hidden]) input'),
        questionsEl
      );
      return;
    }
    try {
      focusLocal(inputEl, composerControls);
    } catch {
      // The webview may not allow focusing a disabled element yet.
    }
  }

  // Event listeners for composer interaction
  inputEl.addEventListener('input', () => {
    saveDraft();
    resizeInput();
    updateComposer();
    store.state.slashIndex = 0;
    refreshSlashMenu();
  });

  inputEl.addEventListener('click', refreshSlashMenu);
  inputEl.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refreshSlashMenu();
  });
  inputEl.addEventListener('blur', () => closeSlashMenu());

  inputEl.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = [];
    if (clipboard.items) {
      for (let index = 0; index < clipboard.items.length; index += 1) {
        const item = clipboard.items[index];
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    if (files.length === 0 && clipboard.files) {
      for (let index = 0; index < clipboard.files.length; index += 1) {
        const file = clipboard.files[index];
        if (file && file.type && file.type.startsWith('image/')) files.push(file);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    if (!store.state.imageSupport) unseenImageNotice();
    addImageFiles(files);
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      // VS Code forwards these keys to the workbench and suppresses the browser
      // default. Keep the shortcut local and run the browser's editing command.
      event.preventDefault();
      event.stopPropagation();
      document.execCommand(key === 'y' || event.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (store.state.slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const items = store.filteredSlashItems(currentSlashQuery());
        if (items.length > 0) {
          event.preventDefault();
          selectSlashItem(store.state.slashIndex);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSend?.(inputEl.value);
      return;
    }
    if (event.key === 'Escape' && store.state.busy) {
      event.preventDefault();
      onStop?.();
    }
  });

  sendBtn.addEventListener('click', () => onSend?.(inputEl.value));
  stopBtn.addEventListener('click', () => onStop?.());

  return {
    updateComposer,
    resizeInput,
    clearInput,
    restoreDraft,
    renderAttachments,
    renderSelection,
    selectContext,
    refreshSlashMenu,
    closeSlashMenu,
    renderConfigOptions,
    focusComposerInput,
    get isInputFocused() { return document.activeElement === inputEl; },
  };
}

module.exports = { createComposerView };

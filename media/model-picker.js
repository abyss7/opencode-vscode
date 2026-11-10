(function () {
  'use strict';

  // Webview resources are cross-origin: Chromium blocks external SVG <use>.
  // Clone the bundled paths from the inert template embedded by the host.
  const icons = new Map(Array.from(document.getElementById('provider-icons')?.content.querySelectorAll('symbol') || [],
    (symbol) => [symbol.id, symbol]));
  const aliases = { 'opencode-go': 'opencode', 'google-vertex': 'google', 'azure-cognitive-services': 'azure' };
  let sequence = 0;
  let activeMenu = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function identity(item) {
    const slash = item.value.indexOf('/');
    const provider = slash > 0 ? item.value.slice(0, slash) : '';
    const full = item.name || item.value;
    const name = provider && full.startsWith(`${provider}/`) ? full.slice(provider.length + 1) : full;
    return { provider, name, label: provider ? `${provider}: ${name}` : name };
  }

  function icon(provider) {
    const id = aliases[provider] || provider;
    let node;
    if (icons.has(id)) {
      const symbol = icons.get(id);
      node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      node.setAttribute('viewBox', symbol.getAttribute('viewBox'));
      node.setAttribute('focusable', 'false');
      node.append(...Array.from(symbol.children, (child) => child.cloneNode(true)));
      node.setAttribute('class', 'model-provider-icon');
    } else {
      const words = provider.split(/[^a-z0-9]+/i).filter(Boolean);
      const initials = words.length > 1 ? words.map((word) => word[0]).join('').slice(0, 2) : provider.slice(0, 2);
      node = element('span', 'model-provider-icon model-provider-fallback', (initials || '?').toUpperCase());
    }
    node.setAttribute('aria-hidden', 'true');
    node.dataset.provider = provider;
    return node;
  }

  function chevron() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'model-picker-chevron');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3.5 5.75 8 10.25 12.5 5.75');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function createMenu({ label, className = '', combobox = false, scrollable = true }) {
    const controller = new AbortController();
    const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler,
      { ...options, signal: controller.signal });
    const root = element('div', `config session-settings ${className}`);
    const button = element('button', 'model-picker-button');
    button.type = 'button';
    if (combobox) button.setAttribute('role', 'combobox');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    const panel = element('div', `session-settings-popup${scrollable ? ' model-picker-list' : ''}`);
    panel.id = `settings-popup-${++sequence}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${label} settings`);
    panel.hidden = true;
    button.setAttribute('aria-controls', panel.id);
    root.append(button, panel);

    function place() {
      const rect = button.getBoundingClientRect();
      const margin = 8;
      const width = Math.max(0, Math.min(360, window.innerWidth - margin * 2));
      const above = rect.top - margin * 2;
      const below = window.innerHeight - rect.bottom - margin * 2;
      const upward = above >= below;
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(440, upward ? above : below))}px`;
      panel.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
      panel.style.top = upward ? 'auto' : `${rect.bottom + margin}px`;
      panel.style.bottom = upward ? `${window.innerHeight - rect.top + margin}px` : 'auto';
    }

    function open() {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (activeMenu !== menu) activeMenu?.close();
      activeMenu = menu;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      menu.onOpen?.();
    }

    function close() {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (activeMenu === menu) activeMenu = null;
      menu.onClose?.();
    }

    const focus = () => OpenCodeRichText.focusWithoutScroll(button, root.closest('#composer-controls'));
    const menu = { element: root, button, panel, listen, open, close, focus,
      containsFocus: () => root.contains(document.activeElement),
      dispose: () => { close(); controller.abort(); root.remove(); } };
    listen(button, 'click', () => { if (panel.hidden) open(); else close(); });
    if (!combobox) listen(button, 'keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        open();
        const first = panel.querySelector('select:not(:disabled), input:not(:disabled), button:not(:disabled)');
        if (first) OpenCodeRichText.focusWithoutScroll(first, root.closest('#composer-controls'));
      }
    });
    listen(root, 'keydown', (event) => {
      if (event.key !== 'Escape' || panel.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      focus();
    });
    // Disabling a selector while its save is pending blurs it to the document.
    // Keep the menu open; an actual Tab/outside click or window blur dismisses it.
    listen(root, 'focusout', (event) => { if (event.relatedTarget && !root.contains(event.relatedTarget)) close(); });
    listen(document, 'pointerdown', (event) => { if (!root.contains(event.target)) close(); }, { capture: true });
    listen(window, 'blur', close);
    listen(window, 'resize', () => { if (!panel.hidden) place(); });
    listen(document, 'scroll', () => { if (!panel.hidden) place(); }, { capture: true });
    return menu;
  }

  function create(option, onChange, { effort, effortLabel } = {}) {
    const menu = createMenu({ label: option.name || 'Model', className: 'model-picker', combobox: true, scrollable: false });
    const { button, panel, listen, close, open } = menu;
    panel.classList.add('model-settings-popup');
    panel.appendChild(element('div', 'session-settings-heading', 'Model'));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'model-picker-search';
    search.placeholder = 'Search models…';
    search.setAttribute('aria-label', 'Search models');
    panel.appendChild(search);
    const list = element('div', 'model-picker-list');
    list.id = `model-list-${sequence}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Models');
    search.setAttribute('aria-controls', list.id);
    const entries = option.options.map((item) => ({ ...item, ...identity(item) }));
    const selected = entries.findIndex((item) => item.value === option.currentValue);
    const current = entries[selected] || identity({ value: option.currentValue || '', name: 'No model selected' });
    button.append(icon(current.provider), element('span', 'model-name', current.name));
    if (effortLabel) {
      button.append(element('span', 'settings-separator', '·'), element('span', 'model-effort', effortLabel));
    }
    button.appendChild(chevron());
    button.title = current.label;
    button.setAttribute('aria-description', `${current.label}${effortLabel ? ` · Effort: ${effortLabel}` : ''}`);
    if (!entries.length && !effort) button.setAttribute('aria-disabled', 'true');
    panel.appendChild(list);
    let active = selected >= 0 ? selected : 0;
    let typed = '';
    let typedAt = 0;
    const rows = entries.map((item, index) => {
      const row = element('div', 'model-picker-option');
      row.id = `${list.id}-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', item.label);
      row.setAttribute('aria-selected', String(index === selected));
      row.title = item.label;
      if (item.description) row.title += `\n${item.description}`;
      row.append(icon(item.provider), element('span', 'model-name', item.name));
      list.appendChild(row);
      listen(row, 'pointermove', () => activate(index, false));
      listen(row, 'mousedown', (event) => event.preventDefault());
      listen(row, 'click', () => choose(index));
      return row;
    });
    const empty = element('div', 'model-picker-empty', 'No matching models');
    empty.hidden = true;
    panel.appendChild(empty);
    if (effort) {
      const section = element('div', 'session-settings-section');
      section.append(effort, element('div', 'session-settings-note', 'Default uses the model setting.'));
      panel.appendChild(section);
    }

    function activate(index, scroll = true) {
      if (!rows.length) return;
      active = Math.max(0, Math.min(rows.length - 1, index));
      if (rows[active].hidden) return;
      rows.forEach((row, i) => row.classList.toggle('active', i === active));
      button.setAttribute('aria-activedescendant', rows[active].id);
      search.setAttribute('aria-activedescendant', rows[active].id);
      if (scroll) OpenCodeRichText.scrollToElement(list, rows[active], { block: 'nearest' });
    }

    menu.onOpen = () => {
      search.value = '';
      rows.forEach((row) => { row.hidden = false; });
      empty.hidden = true;
      activate(selected >= 0 ? selected : 0);
    };
    menu.onClose = () => {
      typed = '';
      button.removeAttribute('aria-activedescendant');
      search.removeAttribute('aria-activedescendant');
    };

    function choose(index) {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const item = entries[index];
      close();
      menu.focus();
      if (!item?.value || item.value === option.currentValue) return;
      // Keep focus while awaiting the host; the replacement picker restores it.
      button.setAttribute('aria-disabled', 'true');
      onChange(item.value);
    }

    listen(button, 'keydown', (event) => {
      if (event.key === 'Tab') return;
      if (button.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      if (event.key === 'Escape') { close(); event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (panel.hidden) open(); else choose(active);
        return;
      }
      const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -Infinity, End: Infinity };
      if (Object.hasOwn(moves, event.key)) {
        event.preventDefault();
        const wasClosed = panel.hidden;
        if (wasClosed) open();
        if (!wasClosed || event.key === 'Home' || event.key === 'End') activate(active + moves[event.key]);
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      const now = Date.now();
      const query = (now - typedAt > 750 ? '' : typed) + event.key.toLowerCase();
      if (panel.hidden) open();
      typed = query;
      typedAt = now;
      const search = [...typed].every((char) => char === typed[0]) ? typed[0] : typed;
      for (let offset = search.length === 1 ? 1 : 0; offset < entries.length + 1; offset++) {
        const index = (active + offset) % entries.length;
        const item = entries[index];
        if (item && (item.name.toLowerCase().startsWith(search) || item.provider.toLowerCase().startsWith(search))) {
          activate(index);
          break;
        }
      }
    });
    listen(search, 'input', () => {
      const query = search.value.trim().toLowerCase();
      rows.forEach((row, index) => { row.hidden = !entries[index].label.toLowerCase().includes(query); });
      const first = rows.findIndex((row) => !row.hidden);
      empty.hidden = first >= 0;
      button.removeAttribute('aria-activedescendant');
      search.removeAttribute('aria-activedescendant');
      if (first >= 0) activate(first);
    });
    listen(search, 'keydown', (event) => {
      const visible = rows.map((row, index) => row.hidden ? -1 : index).filter((index) => index >= 0);
      if (event.key === 'Enter') {
        event.preventDefault();
        if (visible.includes(active)) choose(active);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = Math.max(0, Math.min(visible.length - 1, visible.indexOf(active) + (event.key === 'ArrowDown' ? 1 : -1)));
        if (visible.length) activate(visible[next]);
      }
    });
    return menu;
  }

  window.OpenCodeModelPicker = { create, createMenu, chevron };
})();

(function () {
  'use strict';

  // Webview resources are cross-origin: Chromium blocks external SVG <use>.
  // Clone the bundled paths from the inert template embedded by the host.
  const icons = new Map(Array.from(document.getElementById('provider-icons')?.content.querySelectorAll('symbol') || [],
    (symbol) => [symbol.id, symbol]));
  const aliases = { 'opencode-go': 'opencode', 'google-vertex': 'google', 'azure-cognitive-services': 'azure' };
  let sequence = 0;

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

  function create(option, onChange) {
    const controller = new AbortController();
    const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler,
      { ...options, signal: controller.signal });
    const root = element('div', 'config model-picker');
    root.appendChild(element('span', '', option.name || 'Model'));
    const button = element('button', 'model-picker-button');
    button.type = 'button';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-label', option.name || 'Model');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const list = element('div', 'model-picker-list');
    list.id = `model-list-${++sequence}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Models');
    list.hidden = true;
    button.setAttribute('aria-controls', list.id);
    const entries = option.options.map((item) => ({ ...item, ...identity(item) }));
    const selected = entries.findIndex((item) => item.value === option.currentValue);
    const current = entries[selected] || identity({ value: option.currentValue || '', name: 'No model selected' });
    button.append(icon(current.provider), element('span', 'model-name', current.name), chevron());
    button.title = current.label;
    button.setAttribute('aria-description', current.label);
    if (!entries.length) button.setAttribute('aria-disabled', 'true');
    root.append(button, list);
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

    function activate(index, scroll = true) {
      if (!rows.length) return;
      active = Math.max(0, Math.min(rows.length - 1, index));
      rows.forEach((row, i) => row.classList.toggle('active', i === active));
      button.setAttribute('aria-activedescendant', rows[active].id);
      if (scroll) OpenCodeRichText.scrollToElement(list, rows[active], { block: 'nearest' });
    }

    function place() {
      const rect = button.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(360, window.innerWidth - margin * 2);
      const above = rect.top - margin * 2;
      const below = window.innerHeight - rect.bottom - margin * 2;
      const upward = above >= below;
      list.style.width = `${width}px`;
      list.style.maxHeight = `${Math.max(0, Math.min(320, upward ? above : below))}px`;
      list.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
      list.style.top = upward ? 'auto' : `${rect.bottom + margin}px`;
      list.style.bottom = upward ? `${window.innerHeight - rect.top + margin}px` : 'auto';
    }

    function open() {
      if (button.getAttribute('aria-disabled') === 'true') return;
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      activate(selected >= 0 ? selected : 0);
    }

    function close() {
      list.hidden = true;
      typed = '';
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
    }

    function choose(index) {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const item = entries[index];
      close();
      OpenCodeRichText.focusWithoutScroll(button, root.closest('#composer-controls'));
      if (!item?.value || item.value === option.currentValue) return;
      // Keep focus while awaiting the host; the replacement picker restores it.
      button.setAttribute('aria-disabled', 'true');
      onChange(item.value);
    }

    listen(button, 'click', () => { if (list.hidden) open(); else close(); });
    listen(button, 'keydown', (event) => {
      if (event.key === 'Tab') { close(); return; }
      if (button.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      if (event.key === 'Escape') { close(); event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (list.hidden) open(); else choose(active);
        return;
      }
      const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -Infinity, End: Infinity };
      if (Object.hasOwn(moves, event.key)) {
        event.preventDefault();
        const wasClosed = list.hidden;
        if (wasClosed) open();
        if (!wasClosed || event.key === 'Home' || event.key === 'End') activate(active + moves[event.key]);
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      const now = Date.now();
      const query = (now - typedAt > 750 ? '' : typed) + event.key.toLowerCase();
      if (list.hidden) open();
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
    listen(document, 'pointerdown', (event) => { if (!root.contains(event.target)) close(); }, { capture: true });
    listen(button, 'blur', close);
    listen(window, 'blur', close);
    listen(window, 'resize', () => { if (!list.hidden) place(); });
    return { element: root, focus: () => OpenCodeRichText.focusWithoutScroll(button, root.closest('#composer-controls')), containsFocus: () => root.contains(document.activeElement),
      dispose: () => { controller.abort(); root.remove(); } };
  }

  window.OpenCodeModelPicker = { create };
})();

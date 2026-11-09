/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const select = document.getElementById('default-agent');
  const error = document.getElementById('defaults-error');
  const tree = document.getElementById('sessions-tree');
  const scroll = document.getElementById('sessions-scroll');
  const saved = vscode.getState() || {};
  const expansion = saved.expansion || {};
  let selected = saved.selected;
  let items = [];
  let nodes = new Map();
  const persist = () => vscode.setState({ expansion, selected, scrollTop: scroll.scrollTop });
  const key = (node) => `${node.kind}:${node.id}`;
  const expanded = (node) => Object.hasOwn(expansion, key(node)) ? expansion[key(node)] : node.kind === 'folder';
  const paths = {
    folder: ['M3 6h7l2 2h9v12H3z'], inbox: ['M4 4h16v16H4z', 'M4 13h5l2 3h2l2-3h5'],
    archive: ['M3 3h18v4H3z', 'M5 7v14h14V7', 'M10 11h4'],
    restore: ['M4 4v6h6', 'M4 10a8 8 0 1 1 1 8'],
    trash: ['M3 6h18', 'M9 6V3h6v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
    'comment-discussion': ['M3 3h16v12H9l-4 4v-4H3z'],
    'server-process': ['M4 3h16v7H4z', 'M4 14h16v7H4z', 'M7 6h1', 'M7 17h1'],
    'loading~spin': ['M20 12a8 8 0 1 1-8-8'], chevron: ['m9 5 7 7-7 7'], down: ['m5 9 7 7 7-7'],
    more: ['M5 12h1', 'M11 12h1', 'M17 12h1'],
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths[name] || paths['comment-discussion']) {
      const shape = document.createElementNS(svg.namespaceURI, 'path');
      shape.setAttribute('d', d);
      svg.appendChild(shape);
    }
    if (name === 'loading~spin') svg.classList.add('tree-icon-busy');
    return svg;
  }
  function text(tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }
  function send(action, node, extra = {}) {
    vscode.postMessage({ type: 'sidebarAction', action, sidebarKind: node?.kind, sidebarId: node?.id, ...extra });
  }
  function formatRelative(timestamp) {
    if (!timestamp) return '';
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 60_000) return 'just now';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} d ago`;
    // Use the window's local formatting environment, never the SSH host's locale/timezone.
    return new Intl.DateTimeFormat().format(timestamp);
  }
  function render() {
    const top = scroll.scrollTop;
    const focus = document.activeElement.closest?.('.tree-node')?.dataset.key;
    nodes = new Map();
    function build(list, parent, depth) {
      list.forEach((node, index) => {
        const description = node.timestamp === undefined ? node.description : formatRelative(node.timestamp);
        nodes.set(key(node), node);
        const li = document.createElement('li');
        li.className = 'tree-node';
        li.dataset.key = key(node);
        li.dataset.kind = node.kind;
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-level', depth);
        li.setAttribute('aria-posinset', index + 1);
        li.setAttribute('aria-setsize', list.length);
        li.setAttribute('aria-label', `${node.name}${description ? `, ${description}` : ''}`);
        li.setAttribute('aria-selected', String(selected === key(node)));
        li.tabIndex = selected === key(node) ? 0 : -1;
        const hasChildren = node.kind === 'folder' || node.children?.length > 0;
        if (hasChildren) li.setAttribute('aria-expanded', String(expanded(node)));
        li.dataset.vscodeContext = JSON.stringify({ webviewSection: 'sessions', sidebarId: node.id,
          sidebarKind: node.kind, sidebarArchived: node.archived, sidebarSubagent: node.subagent,
          sidebarCustom: node.custom, preventDefaultContextMenuItems: true });
        const row = text('div', 'tree-row', '');
        row.title = node.tooltip || node.name;
        row.draggable = node.kind === 'session';
        const twisty = text('button', 'twisty', '');
        twisty.tabIndex = -1;
        twisty.disabled = !hasChildren;
        twisty.setAttribute('aria-label', `${expanded(node) ? 'Collapse' : 'Expand'} ${node.name}`);
        twisty.appendChild(icon(expanded(node) ? 'down' : 'chevron'));
        row.append(twisty, icon(node.icon || 'comment-discussion'), text('span', 'tree-label', node.name));
        if (description) row.appendChild(text('span', 'tree-description', description));
        if (node.kind === 'session') {
          const actions = { archiveSession: ['archive', 'Archive'], restoreSession: ['restore', 'Restore'],
            deleteSession: ['trash', 'Delete session'] };
          for (const action of node.actions || []) {
            if (!actions[action]) continue;
            const [name, label] = actions[action];
            const button = text('button', 'tree-action', '');
            button.dataset.action = action;
            button.title = label;
            button.setAttribute('aria-label', `${label}: ${node.name}`);
            button.appendChild(icon(name));
            row.appendChild(button);
          }
        } else if (node.actions?.length) {
          const menu = text('button', 'tree-action', '');
          menu.tabIndex = -1;
          menu.setAttribute('aria-label', `Actions for ${node.name}`);
          menu.appendChild(icon('more'));
          row.appendChild(menu);
        }
        li.appendChild(row);
        parent.appendChild(li);
        if (hasChildren && expanded(node) && node.children?.length) {
          const group = text('ul', 'tree-group', '');
          group.setAttribute('role', 'group');
          li.appendChild(group);
          build(node.children, group, depth + 1);
        }
      });
    }
    tree.replaceChildren();
    build(items, tree, 1);
    document.getElementById('sessions-empty').hidden = items.length > 0;
    const elements = [...tree.querySelectorAll('.tree-node')];
    if (!elements.some((node) => node.tabIndex === 0) && elements[0]) elements[0].tabIndex = 0;
    if (focus) elements.find((node) => node.dataset.key === focus)?.focus({ preventScroll: true });
    scroll.scrollTop = top;
  }
  function focusNode(element) {
    if (!element) return;
    selected = element.dataset.key;
    for (const node of tree.querySelectorAll('.tree-node')) {
      node.tabIndex = node === element ? 0 : -1;
      node.setAttribute('aria-selected', String(node === element));
    }
    element.focus({ preventScroll: true });
    element.querySelector('.tree-row').scrollIntoView({ block: 'nearest' });
    persist();
  }
  function toggle(node) { expansion[key(node)] = !expanded(node); render(); persist(); }
  tree.addEventListener('click', (event) => {
    const element = event.target.closest('.tree-node');
    const node = nodes.get(element?.dataset.key);
    if (!node) return;
    focusNode(element);
    const action = event.target.closest('.tree-action');
    if (action) return send(action.dataset.action || 'menu', node);
    if (event.target.closest('.twisty') || node.kind === 'folder') return toggle(node);
    send(node.kind === 'error' ? 'showLog' : 'openSession', node);
  });
  tree.addEventListener('keydown', (event) => {
    // Let focused action buttons handle Enter/Space as native button clicks.
    if (event.target.closest('.tree-action') && ['Enter', ' '].includes(event.key)) return;
    const element = event.target.closest('.tree-node');
    const node = nodes.get(element?.dataset.key);
    if (!node) return;
    const visible = [...tree.querySelectorAll('.tree-node')];
    const index = visible.indexOf(element);
    const children = node.kind === 'folder' || node.children?.length;
    switch (event.key) {
      case 'ArrowDown': focusNode(visible[Math.min(index + 1, visible.length - 1)]); break;
      case 'ArrowUp': focusNode(visible[Math.max(index - 1, 0)]); break;
      case 'Home': focusNode(visible[0]); break;
      case 'End': focusNode(visible.at(-1)); break;
      case 'ArrowRight':
        if (children && !expanded(node)) toggle(node);
        else if (node.children?.length) focusNode(visible[index + 1]);
        break;
      case 'ArrowLeft':
        if (children && expanded(node)) toggle(node);
        else focusNode(element.parentElement.closest('.tree-node'));
        break;
      case 'Enter':
        if (node.kind === 'folder') toggle(node);
        else send(node.kind === 'error' ? 'showLog' : 'openSession', node);
        break;
      case ' ': if (children) toggle(node); break;
      case 'F2': if (node.actions?.includes('renameSession')) send('renameSession', node); break;
      case 'Delete': {
        const action = node.kind === 'folder' ? 'deleteFolder' : 'deleteSession';
        if (node.actions?.includes(action)) send(action, node);
        break;
      }
      default: return;
    }
    event.preventDefault();
  });
  tree.addEventListener('dragstart', (event) => {
    const node = nodes.get(event.target.closest('.tree-node')?.dataset.key);
    if (node?.kind !== 'session') return event.preventDefault();
    event.dataTransfer.setData('application/x-opencode-session', node.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  tree.addEventListener('dragover', (event) => {
    const folder = event.target.closest('.tree-node[data-kind="folder"]');
    if (!folder || !event.dataTransfer.types.includes('application/x-opencode-session')) return;
    event.preventDefault();
    for (const target of tree.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
    folder.classList.add('drop-target');
    event.dataTransfer.dropEffect = 'move';
  });
  tree.addEventListener('drop', (event) => {
    const folder = nodes.get(event.target.closest('.tree-node[data-kind="folder"]')?.dataset.key);
    if (!folder) return;
    event.preventDefault();
    send('drop', { kind: 'session', id: event.dataTransfer.getData('application/x-opencode-session') }, { folderId: folder.id });
    for (const target of tree.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
  });
  tree.addEventListener('dragend', () => {
    for (const target of tree.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
  });
  scroll.addEventListener('scroll', persist);
  document.getElementById('new-session').addEventListener('click', () => send('newSession'));
  document.getElementById('download-opencode').addEventListener('click', (event) => {
    event.preventDefault();
    send('downloadOpenCode');
  });
  document.getElementById('retry-connection').addEventListener('click', () => send('retryConnection'));
  function connectionError(message) {
    const unavailable = Boolean(message);
    document.getElementById('connection-error').hidden = !unavailable;
    scroll.hidden = unavailable;
    document.querySelector('.defaults-footer').hidden = unavailable;
    document.getElementById('connection-title').textContent = /ENOENT|command not found/i.test(message || '')
      ? 'OpenCode was not found' : 'OpenCode is unavailable';
    document.getElementById('connection-description').textContent =
      'Install OpenCode on the machine where this workspace is running, or check your connection and try again. For Remote SSH, install it on the remote server.';
    document.getElementById('connection-details').textContent = message || '';
  }
  select.addEventListener('change', () => {
    select.disabled = true;
    vscode.postMessage({ type: 'selectAgent', agent: select.value });
  });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'sessions') {
      items = data.items || [];
      connectionError(items.find((item) => item.kind === 'error')?.name);
      items = items.filter((item) => item.kind !== 'error');
      const initial = !tree.children.length;
      render();
      if (initial) scroll.scrollTop = saved.scrollTop || 0;
      return;
    }
    if (data.type === 'connectionError') {
      connectionError(data.error);
      return;
    }
    if (data.type !== 'sessionDefaults') return;
    select.replaceChildren();
    for (const agent of data.agents || []) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      option.title = agent.description;
      option.selected = agent.id === data.selected;
      select.appendChild(option);
    }
    select.disabled = !select.options.length;
    error.textContent = data.error || '';
    error.hidden = !data.error;
  });
  vscode.postMessage({ type: 'ready' });
})();

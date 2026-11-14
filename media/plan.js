(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const STATUS_LABELS = { todo: 'To do', doing: 'Doing', done: 'Done', skipped: 'Skipped' };
  const CHECK_SVG = '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 12.1 2.6 8.5l1.3-1.3 2.3 2.3 5.9-5.9 1.3 1.3z"/></svg>';
  const PULSE_SVG = '<svg class="pulse" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>';
  const DASH_SVG = '<svg class="dash" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 7.25h9v1.5h-9z"/></svg>';

  let plan = null;   // { id, title, sessionTitle, latest, versions, overlay, dirty }
  let viewing = null; // viewed version number

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const titleEl = $('plan-title');
  const metaEl = $('plan-meta');
  const barEl = $('plan-bar');
  const progressTextEl = $('plan-progress-text');
  const syncEl = $('plan-sync');
  const syncTextEl = $('plan-sync-text');
  const revertBtn = $('plan-revert');
  const oldEl = $('plan-old');
  const bodyEl = $('plan-body');
  const versionsEl = $('plan-versions');
  const exportBtn = $('plan-export');
  const copyBtn = $('plan-copy');

  const effective = (task) => (plan.overlay[task.id] !== undefined ? plan.overlay[task.id] : task.status);
  const isChanged = (task) => plan.dirty.includes(task.id);
  const current = () => {
    if (!plan) return null;
    return plan.versions.find((item) => item.version === viewing) || plan.versions[plan.versions.length - 1];
  };

  function render() {
    if (!plan) return;
    document.title = plan.title;
    titleEl.textContent = plan.title;
    renderMeta();
    renderVersions();
    renderBody();
    app.hidden = false;
  }

  function renderMeta() {
    const revision = current();
    const tasks = allTasks(revision.value);
    const counts = countStatuses(tasks);
    metaEl.replaceChildren();
    metaEl.append(document.createTextNode(plan.sessionTitle || 'Session plan'));
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `v${revision.version}`;
    metaEl.append(badge);

    const segments = [
      ['done', counts.done, counts.done],
      ['doing', counts.doing, counts.doing],
      ['skipped', counts.skipped, counts.skipped],
    ];
    barEl.replaceChildren(...segments.filter(([, width]) => width > 0).map(([status, width]) => {
      const span = document.createElement('span');
      span.className = status;
      span.style.width = `${(width / tasks.length) * 100}%`;
      return span;
    }));
    const bits = [`${counts.done}/${tasks.length} done`];
    if (counts.doing) bits.push(`${counts.doing} doing`);
    if (counts.skipped) bits.push(`${counts.skipped} skipped`);
    progressTextEl.textContent = bits.join(' · ');
  }

  function renderVersions() {
    versionsEl.replaceChildren(...plan.versions.map((item) => {
      const option = document.createElement('option');
      option.value = String(item.version);
      option.textContent = `v${item.version}`;
      return option;
    }));
    versionsEl.value = String(viewing);
  }

  function renderBody() {
    const revision = current();
    const latest = plan.latest;
    const readOnly = revision.version !== latest;
    bodyEl.classList.toggle('tasks-disabled', readOnly);

    oldEl.hidden = !readOnly;
    if (readOnly) oldEl.textContent = `Viewing v${revision.version} — the latest is v${latest}. Switch back to tick tasks.`;

    const dirtyCount = plan.dirty.length;
    syncEl.hidden = dirtyCount === 0;
    if (dirtyCount) syncTextEl.textContent =
      `${dirtyCount} change${dirtyCount === 1 ? '' : 's'} — sent with your next message`;

    bodyEl.replaceChildren();
    for (const phase of revision.value.phases) {
      const tasks = phase.tasks;
      const done = tasks.filter((task) => effective(task) === 'done').length;
      const complete = done === tasks.length;

      const card = document.createElement('section');
      card.className = `phase${complete ? ' complete' : ''}`;

      const header = document.createElement('div');
      header.className = 'phase-header';
      const heading = document.createElement('h2');
      heading.className = 'phase-title';
      heading.textContent = phase.title;
      const count = document.createElement('span');
      count.className = 'phase-count';
      count.textContent = `${done}/${tasks.length}`;
      header.append(heading, count);

      const bar = document.createElement('div');
      bar.className = 'phase-bar';
      const fill = document.createElement('span');
      fill.style.width = `${(done / tasks.length) * 100}%`;
      bar.append(fill);

      const list = document.createElement('div');
      list.className = 'tasks';
      for (const task of tasks) list.append(taskRow(task, readOnly));

      card.append(header, bar, list);
      bodyEl.append(card);
    }
  }

  function taskRow(task, readOnly) {
    const status = effective(task);
    const changed = isChanged(task);

    const row = document.createElement('div');
    row.className = `task${changed ? ' changed' : ''} ${status}`;
    row.dataset.status = status;
    row.dataset.taskId = task.id;

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'task-check';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(status === 'done'));
    check.setAttribute('aria-label', `${task.title}: ${STATUS_LABELS[status]}`);
    check.title = 'Click to toggle done · use the status menu for doing/skipped';
    check.innerHTML = CHECK_SVG + PULSE_SVG + DASH_SVG;
    check.disabled = readOnly;
    check.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggle', taskId: task.id, status: status === 'done' ? 'todo' : 'done' });
    });

    const body = document.createElement('div');
    body.className = 'task-body';
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    body.append(title);
    if (task.note) {
      const note = document.createElement('div');
      note.className = 'task-note';
      note.textContent = task.note;
      body.append(note);
    }

    const side = document.createElement('div');
    side.className = 'task-side';
    const id = document.createElement('span');
    id.className = 'task-id';
    id.textContent = task.id;
    id.title = 'Task id — reference it when talking about this task';
    const select = document.createElement('select');
    select.className = 'task-status';
    select.setAttribute('aria-label', `Status of ${task.title}`);
    select.disabled = readOnly;
    for (const [value, label] of Object.entries(STATUS_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (value === status) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggle', taskId: task.id, status: select.value });
    });
    side.append(id, select);

    row.append(check, body, side);
    return row;
  }

  function allTasks(value) {
    return value.phases.flatMap((phase) => phase.tasks);
  }

  function countStatuses(tasks) {
    const counts = { todo: 0, doing: 0, done: 0, skipped: 0 };
    for (const task of tasks) counts[effective(task)] += 1;
    return counts;
  }

  function toMarkdown() {
    const revision = current();
    const tasks = allTasks(revision.value);
    const counts = countStatuses(tasks);
    const lines = [`# ${plan.title} (v${revision.version})`, '',
      `> Progress: ${counts.done}/${tasks.length} done` +
      (counts.skipped ? ` · ${counts.skipped} skipped` : ''), ''];
    for (const phase of revision.value.phases) {
      const done = phase.tasks.filter((task) => effective(task) === 'done').length;
      lines.push(`## ${phase.title} (${done}/${phase.tasks.length})`, '');
      for (const task of phase.tasks) {
        const status = effective(task);
        const title = status === 'skipped' ? `~~${task.title}~~ *(skipped)*` : task.title;
        lines.push(`- [${status === 'done' ? 'x' : ' '}] ${title} \`${task.id}\`${status === 'doing' ? ' *(doing)*' : ''}`);
        if (task.note) lines.push(`  - ${task.note}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  versionsEl.addEventListener('change', () => {
    viewing = Number(versionsEl.value);
    render();
  });

  revertBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'reset' });
  });

  exportBtn.addEventListener('click', () => {
    const name = `${plan.id}-v${viewing}.md`;
    vscode.postMessage({ type: 'export', name, markdown: toMarkdown() });
  });

  copyBtn.addEventListener('click', async () => {
    const revision = current();
    try {
      await navigator.clipboard.writeText(JSON.stringify(revision.value, null, 2));
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1200);
    } catch {
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1200);
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'plan') {
      plan = message;
      viewing = plan.latest;
      render();
    } else if (message.type === 'state' && plan && plan.id === message.id) {
      Object.assign(plan, { overlay: message.overlay, dirty: message.dirty, latest: message.latest });
      if (message.sessionTitle) plan.sessionTitle = message.sessionTitle;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

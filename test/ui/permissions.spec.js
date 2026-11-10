'use strict';

const { test, expect } = require('./fixture');
const profiles = [
  { id: 'read-only', label: 'Read only' }, { id: 'workspace', label: 'Workspace' },
  { id: 'host', label: 'Host' }, { id: 'all', label: 'All ⚠' }, { id: 'review', label: 'Review' },
];
const policy = (change = {}) => ({ type: 'permissionProfile', profiles,
  selected: 'workspace', newActions: 'ask', layers: ['Built-in', 'User', 'Host / Remote', 'Workspace'], ...change });

const permission = (toolCall) => ({ type: 'permission', requestId: 'permission-preview', toolCall,
  options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] });

test('permission shows all files and proposed changes before approval', async ({ page, chat }) => {
  const changes = [
    { type: 'diff', path: 'src/example.js', oldText: 'before();\n', newText: 'after();\n' },
    { type: 'diff', path: 'new.txt', oldText: null, newText: '<script>unsafe()</script>\n' },
  ];
  await chat.send(permission({ title: '2 files', name: 'patch', kind: 'edit',
    locations: changes.map(({ path }) => ({ path })), content: changes }));
  const card = page.locator('.permission');
  const files = card.locator('.permission-file');
  await expect(files.locator('summary')).toHaveText(['Change · src/example.js', 'Create · new.txt']);
  await expect(card.locator('.permission-file[open]')).toHaveCount(0);
  await expect(files.first()).toHaveCSS('border-top-width', '0px');
  await expect(files.first().locator('summary')).toHaveCSS('border-top-width', '0px');
  expect(await files.first().locator('summary').evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"›"');
  await chat.snapshot('plain-file-list');
  await files.nth(0).locator('summary').click();
  await expect(files.nth(0).locator('.tool-diff')).toBeVisible();
  expect(await files.first().locator('summary').evaluate((node) => getComputedStyle(node, '::before').transform)).not.toBe('none');
  await expect(files.nth(1).locator('.tool-diff')).not.toBeVisible();
  await files.nth(1).locator('summary').click();
  await expect(card.locator('.permission-operation')).toHaveText('Edit files · patch');
  await expect(card.locator('.removed .diff-code')).toHaveText('before();');
  await expect(card.locator('.added .diff-code')).toHaveText(['after();', '<script>unsafe()</script>']);
  await expect(card.locator('script')).toHaveCount(0);
  await card.getByRole('button', { name: 'Open diff', exact: true }).first().click();
  expect(await chat.received('openDiff')).toEqual([{ ...changes[0], type: 'openDiff' }]);
  expect(await chat.received('permissionResponse')).toEqual([]);
  expect(await page.locator('#messages').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await chat.snapshot('permission-preview');
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  expect(await chat.received('permissionResponse')).toEqual([
    { type: 'permissionResponse', requestId: 'permission-preview', optionId: 'once' },
  ]);
  await expect(card.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
});

test('expanded file previews grow with their contents and only the chat scrolls vertically', async ({ page, chat }) => {
  const changes = ['first.txt', 'second.txt'].map((path) => ({ type: 'diff', path, oldText: '',
    newText: Array.from({ length: 80 }, (_, index) => `${index}: ${'long line '.repeat(25)}`).join('\n') + '\n' }));
  await chat.send(permission({ title: '2 files', kind: 'edit', content: changes }));
  const files = page.locator('.permission-file');
  for (const summary of await files.locator('summary').all()) await summary.click();
  await expect(page.locator('.permission-file[open]')).toHaveCount(2);
  for (const preview of await page.locator('.permission-preview, .permission-preview .result-scroll').all()) {
    expect(await preview.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  }
  expect(await page.locator('#messages').evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await page.locator('#messages').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await files.first().locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(files.first().locator('.tool-diff')).not.toBeVisible();
  await expect(files.last()).toHaveAttribute('open', '');
  await chat.snapshot('independent-file-previews');
  expect(await chat.received('permissionResponse')).toEqual([]);
});

test('rename pairs source and destination and explicit deletion differs from clearing a file', async ({ page, chat }) => {
  const rename = { type: 'diff', path: '/workspace/ready.txt', oldText: 'draft\n', newText: 'ready\n' };
  const content = [rename,
    { type: 'diff', path: '/workspace/obsolete.txt', oldText: 'obsolete\n', newText: '' },
    { type: 'diff', path: '/workspace/empty.txt', oldText: 'old\n', newText: '' }];
  await chat.send(permission({ title: '3 files', name: 'patch', kind: 'edit', content,
    locations: [{ path: '/workspace/draft.txt' }, ...content.map(({ path }) => ({ path }))],
    rawInput: JSON.stringify({ patchText: '*** Begin Patch\n*** Update File: ./draft.txt\n*** Move to: ready.txt\n@@\n-draft\n+ready\n*** Delete File: obsolete.txt\n*** Update File: empty.txt\n@@\n-old\n*** End Patch' }),
  }));
  await expect(page.locator('.permission-files > li')).toHaveCount(3);
  await expect(page.locator('.permission-file > summary')).toHaveText([
    'Rename · /workspace/draft.txt → /workspace/ready.txt',
    'Delete · /workspace/obsolete.txt', 'Change · /workspace/empty.txt',
  ]);
  const file = page.locator('.permission-file').first();
  await file.locator('summary').click();
  await expect(file.locator('.file-ref')).toHaveAttribute('data-file', '/workspace/draft.txt');
  await expect(file.locator('.file-ref')).toHaveText('Open source file');
  await file.getByRole('button', { name: 'Open diff', exact: true }).click();
  expect(await chat.received('openDiff')).toEqual([{ ...rename, type: 'openDiff' }]);
  await chat.snapshot('rename-permission');
});

test('permission shows command and cwd and preserves raw arguments', async ({ page, chat }) => {
  await chat.send(permission({ title: 'shell', kind: 'execute', rawInput: JSON.stringify({
    command: 'rm -- old.txt', workdir: '/workspace/project', timeout: 1000,
  }) }));
  await expect(page.locator('.permission-command')).toHaveText('rm -- old.txt');
  await expect(page.locator('.permission-directory')).toHaveText('Working directory: /workspace/project');
  await page.getByText('Operation arguments', { exact: true }).click();
  await expect(page.locator('.permission-input pre')).toContainText('1000');
  expect(await chat.received('permissionResponse')).toEqual([]);
});

test('permission without diff shows paths and arguments without inventing a preview', async ({ page, chat }) => {
  await chat.send(permission({ title: 'edit', kind: 'edit', locations: [{ path: 'old.txt', line: 7 }],
    rawInput: { filePath: 'old.txt', oldString: 'before', newString: 'after' } }));
  await expect(page.locator('.permission-files')).toHaveText('old.txt:7');
  await expect(page.locator('.permission-note')).toHaveText('No change preview was provided by OpenCode.');
  await expect(page.locator('.permission-input pre')).toBeVisible();
  await expect(page.locator('.permission-input pre')).toContainText('after');
  await expect(page.locator('.tool-diff')).toHaveCount(0);
});

test('agent is fixed, profile and fallback are independent selectors', async ({ page, chat }) => {
  await chat.send({ type: 'config', configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [
      { value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' },
    ] },
    { id: 'model', name: 'Model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Model A' }] },
  ] }, policy());
  await expect(page.locator('#agent-label')).toHaveText('Agent: Build');
  await expect(page.locator('#config-bar')).not.toContainText('Agent: Build');
  await expect(page.locator('#config-bar input[type=checkbox]')).toHaveCount(0);
  await expect(page.getByLabel('Profile', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(page.getByLabel('Profile', { exact: true })).toHaveValue('workspace');
  await page.getByLabel('Without a rule', { exact: true }).selectOption('forbid');
  expect(await chat.received('setPermissionProfile')).toEqual([{ type: 'setPermissionProfile', newActions: 'forbid' }]);
  await expect(page.getByLabel('Profile', { exact: true })).toBeDisabled();
  await chat.send(policy({ newActions: 'forbid' }));
  await expect(page.getByLabel('Without a rule', { exact: true })).toBeEnabled();
  await page.getByLabel('Profile', { exact: true }).selectOption('read-only');
  await chat.send(policy({ selected: 'read-only', newActions: 'forbid', fallbackLocked: true }));
  await expect(page.getByLabel('Without a rule', { exact: true })).toBeDisabled();
  expect(await chat.received('setConfigOption')).toEqual([]);
});

test('profile choices restore from server and inherited policies are locked', async ({ page, chat }) => {
  await chat.send(policy({ selected: 'all', newActions: 'permit', fallbackLocked: true }));
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(page.getByLabel('Without a rule', { exact: true })).toBeDisabled();
  await chat.send(policy({ newActions: 'forbid' }));
  await expect(page.getByLabel('Without a rule', { exact: true })).toHaveValue('forbid');
  await expect(page.getByLabel('Profile', { exact: true })).toHaveAttribute('title', /Host \/ Remote/);
  await chat.send(policy({ inherited: true }));
  await expect(page.getByLabel('Profile', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Without a rule', { exact: true })).toBeDisabled();
  await expect(page.locator('#config-bar')).toContainText('Inherited from parent');
});

test('Smart selector and reviewer decisions stay distinct from manual approvals', async ({ page, chat }) => {
  await chat.send(policy());
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await page.getByLabel('Without a rule', { exact: true }).selectOption('smart');
  expect(await chat.received('setPermissionProfile')).toEqual([{ type: 'setPermissionProfile', newActions: 'smart' }]);
  await chat.send(policy({ newActions: 'smart' }));
  await chat.update({ sessionUpdate: 'tool_call', toolCallId: 'smart-call', kind: 'execute', title: 'git status', status: 'pending' });
  const review = { id: 'review-1', sessionID: 'ses_visual_fixture', toolCallId: 'smart-call', classifier: 'permission-classifier', action: 'shell',
    resource: 'git status', status: 'reviewing', reason: '' };
  await chat.send({ type: 'smartReviews', reviews: [review] });
  await expect(page.locator('.smart-review')).toContainText('Reviewing · permission-classifier');
  await expect(page.locator('.tool-entry > .smart-review')).toHaveCount(1);
  await expect(page.locator('#messages > .smart-review')).toHaveCount(0);
  await chat.send({ type: 'smartReviews', reviews: [{ ...review, status: 'allow', reason: 'Requested local inspection.', model: 'test/reviewer' }] });
  await expect(page.locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('.smart-review')).toContainText('Allowed');
  await expect(page.locator('.smart-review')).toContainText('Requested local inspection.');
  await expect(page.locator('.smart-review button')).toHaveCount(0);
  await chat.send({ type: 'smartReviews', reviews: [{ ...review, id: 'review-2', status: 'deny', reason: '<script>unsafe()</script>' }] });
  await expect(page.locator('.smart-review').last()).toContainText('Blocked');
  await expect(page.locator('.smart-review script')).toHaveCount(0);
});

test('Host is selectable and project rules open directly', async ({ page, chat }) => {
  await chat.send(policy());
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await page.getByLabel('Profile', { exact: true }).selectOption('host');
  expect(await chat.received('setPermissionProfile')).toEqual([{ type: 'setPermissionProfile', profile: 'host' }]);
  await chat.send(policy({ selected: 'host', newActions: 'permit', fallbackLocked: true }));
  await expect(page.getByLabel('Without a rule', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Profile', { exact: true })).toHaveAttribute('title', /same access as All/);
  await page.getByRole('button', { name: 'Open permission rules', exact: true }).click();
  expect(await chat.received('openPermissionRules')).toEqual([{ type: 'openPermissionRules' }]);
});

test('remembered rules show exact scope and wait for persistence before resolving', async ({ page, chat }) => {
  const request = { ...permission({ title: 'outside.txt', kind: 'edit', locations: [{ path: '/outside/file.txt' }] }),
    policy: { profileLabel: 'Workspace', reason: 'Built-in: edit * → ask', choices: [
      { id: 'exact', label: 'These exact files', rules: [{ action: 'edit', resource: '/outside/file.txt', match: 'exact' }] },
      { id: 'directory', label: 'Containing directories and their contents', rules: [{ action: 'edit', resource: '/outside/*', match: 'glob' }] },
    ] } };
  await chat.send(request);
  const card = page.locator('.permission');
  await expect(card.locator('.permission-reason')).toHaveText('Built-in: edit * → ask');
  await page.getByText('Save rule…', { exact: true }).click();
  await expect(card).toContainText('All sessions in this project · Workspace');
  await expect(card.locator('select')).toHaveCount(2);
  await page.getByLabel('Rule target').selectOption('directory');
  await page.getByLabel('Rule decision').selectOption('deny');
  await expect(card.locator('.permission-rule-preview')).toHaveText('Forbid edit · /outside/* (glob)');
  await chat.snapshot('remember-project-rule');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  expect(await chat.received('savePermissionRule')).toEqual([
    { type: 'savePermissionRule', requestId: 'permission-preview', choiceId: 'directory', effect: 'deny' },
  ]);
  expect(await chat.received('permissionResponse')).toEqual([]);
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled();
  await chat.send({ type: 'permissionRuleResult', requestId: request.requestId, error: 'Disk full', policy: request.policy });
  await expect(card.getByRole('alert')).toHaveText('Disk full');
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled();
  await page.getByText('Save rule…', { exact: true }).click();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await chat.send({ type: 'permissionRuleResult', requestId: request.requestId, note: 'Allow saved for this project · Workspace' });
  await expect(card.getByRole('status')).toHaveText('Allow saved for this project · Workspace');
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  expect(await page.locator('#messages').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

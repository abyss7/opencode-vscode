'use strict';

const { test, expect } = require('./fixture');
const tool = (chat, toolCallId, kind, rawInput, extra = {}) => chat.update({
  sessionUpdate: 'tool_call', toolCallId, kind, title: kind, rawInput, status: 'completed', ...extra,
});
const summary = (page) => page.locator('.turn-steps > summary');

test('summaries preserve steps and count unique files separately from tool totals', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect the files before updating them.' } });
  await tool(chat, 'read-a', 'read', { path: 'src/a.js' });
  await tool(chat, 'read-b', 'read', { path: 'src/b.js' });
  await tool(chat, 'read-again', 'read', { path: '/workspace/src/./a.js' });
  await tool(chat, 'patch', 'edit', { patchText: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-before\n+after\n*** Add File: src/c.js\n+created\n*** End Patch' });
  await tool(chat, 'run', 'execute', { command: 'npm run check' });
  await tool(chat, 'unknown', 'other', {});
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });

  await expect(summary(page).locator('.kind')).toHaveText('7 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Read 2 files', 'Edited 2 files', 'Ran 1 command', '1 other call']);
  await expect(summary(page)).not.toContainText(/thought|Execut(?:ed|ing)/);
  await chat.send({ type: 'turnStats', scope: 'last', turns: [{ steps: 20, kinds: ['thought', 'read', 'other'], tokens: 12345, cacheRead: 11000, cacheWrite: 0, exact: true }] });
  await expect(summary(page).locator('.kind')).toHaveText('20 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Read 2 files', 'Edited 2 files', 'Ran 1 command', '1 other call']);
  await expect(summary(page).locator('.tokens')).toContainText('cache read');

  const box = await summary(page).boundingBox();
  const title = await summary(page).locator('.kind').boundingBox();
  const meta = await summary(page).locator('.name').boundingBox();
  const tokens = await summary(page).locator('.tokens').boundingBox();
  expect(tokens.x + tokens.width).toBeCloseTo(box.x + box.width, 0);
  if (page.viewportSize().width <= 600) {
    expect(meta.x).toBe(title.x);
    expect(meta.y).toBeGreaterThan(title.y);
  } else {
    expect(meta.x).toBeGreaterThan(title.x + title.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Without a text answer the turn still settles: the chevron appears and the
  // steps collapse instead of staying forced open.
  await expect(page.locator('.turn-steps')).not.toHaveAttribute('open', '');
  await page.locator('.turn-steps > summary').click();
  await expect(page.locator('.turn-steps')).toHaveAttribute('open', '');
  const group = page.locator('.tool-group > summary');
  await expect(group).toHaveCount(6);
  await expect(group.locator('.step-metric')).toHaveCount(0);
  for (const step of await group.all()) await expect(step).toBeVisible();
  await group.first().click();
  await expect(page.locator('.tool-group').first()).toHaveAttribute('open', '');
  await expect(page.locator('.tool-group[open]')).toHaveCount(1);
  await chat.snapshot('step-summary-alignment');
});

test('pending and failed tools are not reported as successfully edited files', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'read', 'read', { path: 'src/a.js' });
  await tool(chat, 'edit', 'edit', { path: 'src/b.js' }, { status: 'in_progress' });
  await expect(summary(page).locator('.kind')).toHaveText('2 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Read 1 file', '1 running']);
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'failed' });
  await expect(summary(page).locator('.kind')).toHaveText('2 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Read 1 file', '1 failed']);
  await tool(chat, 'no-path', 'read', {});
  await expect(summary(page).locator('.step-metric')).toHaveText(['Read 2 times', '1 failed']);
});

test('command-only summaries do not repeat the tool total', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  for (let index = 0; index < 52; index += 1) {
    await tool(chat, `shell-${index}`, 'execute', { command: 'pwd' });
  }
  await expect(summary(page).locator('.kind')).toHaveText('52 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText(['Ran 52 commands']);
  await expect(summary(page)).not.toContainText(/Execut(?:ed|ing)|tools/);
});

test('other calls and unfinished statuses stay distinct from successful actions', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'skill', 'other', {});
  await tool(chat, 'agent', 'other', {});
  await tool(chat, 'queued', 'execute', {}, { status: 'pending' });
  await tool(chat, 'running', 'execute', {}, { status: 'in_progress' });
  await tool(chat, 'failed', 'other', {}, { status: 'failed' });
  await tool(chat, 'cancelled', 'edit', { path: 'src/a.js' }, { status: 'cancelled' });
  await expect(summary(page).locator('.kind')).toHaveText('6 steps');
  await expect(summary(page).locator('.step-metric')).toHaveText([
    '2 other calls', '1 pending', '1 running', '1 failed', '1 cancelled',
  ]);
  await expect(summary(page)).not.toContainText(/Ran|Edited|Executed/);
  const queued = page.locator('.tool-group').filter({ has: page.locator('[data-tool-call-id="queued"]') });
  await expect(queued.locator(':scope > summary > .kind')).toHaveText('1 tool call');
  await expect(queued.locator(':scope > summary > .status')).toHaveText('pending');
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'running', status: 'completed' });
  await expect(summary(page).locator('.step-metric')).toHaveText([
    'Ran 1 command', '2 other calls', '1 pending', '1 failed', '1 cancelled',
  ]);
});

test('thought-only details keep their step count without category enumeration', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Check the existing structure.' } });
  await expect(summary(page).locator('.kind')).toHaveText('1 step');
  await expect(summary(page).locator('.name')).toBeHidden();
  await expect(summary(page)).not.toContainText(/thought|other/);
});

test('trailing steps stream raw without a chevron and collapse once the answer arrives', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking around.' } });
  await tool(chat, 'read', 'read', { path: 'src/a.js' });
  const block = page.locator('.turn-steps');
  // While the turn runs there is no chevron: the steps cannot be collapsed.
  await expect(block).toHaveClass(/live/);
  await expect(block).toHaveAttribute('open', '');
  await expect(block.locator(':scope > summary')).toBeHidden();
  await expect(block.locator('.tool-group > summary')).toBeVisible();
  // Streamed steps sit flush like standalone background commands: no rail,
  // no indent — children align with the block's own left edge.
  const flush = await block.evaluate((node) => {
    const body = node.querySelector(':scope > .body');
    const styles = getComputedStyle(body);
    const child = body.firstElementChild;
    return {
      padding: styles.paddingLeft,
      border: styles.borderLeftWidth,
      indent: child.getBoundingClientRect().left - node.getBoundingClientRect().left,
    };
  });
  expect(flush.padding).toBe('0px');
  expect(flush.border).toBe('0px');
  expect(Math.abs(flush.indent)).toBeLessThan(1);
  // No chevron means no Collapse button either: the stream cannot be folded.
  await expect(block.locator(':scope > .disclosure-collapse')).toHaveCount(0);
  // The final answer settles the block: the chevron appears and it folds.
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(block).not.toHaveClass(/live/);
  await expect(block.locator(':scope > summary')).toBeVisible();
  await expect(block).not.toHaveAttribute('open', '');
  await expect(summary(page).locator('.kind')).toHaveText('2 steps');
  // Once the chevron exists, expanding brings the Collapse button back.
  await block.locator(':scope > summary').click();
  await expect(block).toHaveAttribute('open', '');
  await expect(block.locator(':scope > .disclosure-collapse')).toBeVisible();
});

test('a turn that never delivers an answer still reveals the chevron and collapses', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'read', 'read', { path: 'src/a.js' });
  await expect(page.locator('.turn-steps')).toHaveClass(/live/);
  await chat.send({ type: 'turnEnd', stopReason: 'cancelled' });
  await expect(page.locator('.turn-steps')).not.toHaveClass(/live/);
  await expect(page.locator('.turn-steps')).not.toHaveAttribute('open', '');
  await expect(summary(page).locator('.kind')).toHaveText('1 step');
  await expect(page.locator('.info').last()).toContainText('No text answer in this turn');
});

test('transport status blips never fold the streamed steps', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'read', 'read', { path: 'src/a.js' });
  const block = page.locator('.turn-steps');
  await expect(block).toHaveClass(/live/);
  // Reconnects and polling must not touch the raw stream: the run continues
  // on the server, and only semantic turn ends may settle the block.
  await chat.send({ type: 'status', state: 'connecting', message: 'Reconnecting — server work continues.' });
  await expect(block).toHaveClass(/live/);
  await expect(block).toHaveAttribute('open', '');
  await expect(block.locator(':scope > summary')).toBeHidden();
  await chat.send({ type: 'status', state: 'ready' });
  await expect(block).toHaveClass(/live/);
  await expect(block).toHaveAttribute('open', '');
  await tool(chat, 'more', 'read', { path: 'src/b.js' });
  await expect(block.locator('.tool-group > summary')).toHaveCount(2);
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(block).not.toHaveClass(/live/);
  await expect(block).not.toHaveAttribute('open', '');
  await expect(summary(page).locator('.kind')).toHaveText('2 steps');
});

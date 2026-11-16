'use strict';

const { test, expect } = require('./fixture');
const { thoughtTranscript } = require('../../src/thought-transcript');

function history(turns = 60) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push(
      { id: `user-${i}`, type: 'user', text: `Inspect item ${i}`, time: { created: 1000 + i * 10 } },
      { id: `work-${i}`, type: 'assistant', time: { created: 1001 + i * 10, completed: 1002 + i * 10 }, content: [
        { type: 'reasoning', text: `Inspecting item ${i}\nDetailed reasoning for this item.` },
        { type: 'tool', update: {
          toolCallId: `tool-${i}`, title: 'Read file', kind: 'read', status: 'completed',
          rawInput: { path: `src/item-${i}.js` },
          content: [{ type: 'content', content: { type: 'text', text: `Output ${i}` } }],
        } },
        { type: 'reasoning', text: '**Checked item**' },
      ] },
      { id: `answer-${i}`, type: 'assistant', time: { created: 1003 + i * 10, completed: 1004 + i * 10 },
        content: [{ type: 'text', text: `**Result ${i}**\n\nThe item is ready.` }] },
      { id: `idle-${i}`, type: 'idle', outcome: 'succeeded' },
    );
  }
  return thoughtTranscript(messages, 'ses_visual_fixture').messages;
}

const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const snapshot = messages => ({ type: 'transcript', messages, inbox: [] });

// Playwright trace DOM snapshots themselves measure hidden descendants and
// force hundreds of layouts. Keep them out of this suite's performance counter.
test.use({ trace: 'off' });

test('large initial history builds final folded blocks with a bounded number of browser layouts', async ({ page, chat }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await frames(page);
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const before = await metrics();
  await chat.send(snapshot(history()), { type: 'historyEnd' });
  await frames(page);
  const after = await metrics();
  // Count browser layouts rather than timing a shared CI host. The old path
  // forces layout after each thought/tool; snapshot construction must not.
  expect(after.LayoutCount - before.LayoutCount).toBeLessThan(20);
  expect(after.RecalcStyleCount - before.RecalcStyleCount).toBeLessThan(20);
  await expect(page.locator('.message.user')).toHaveCount(60);
  await expect(page.locator('.message.assistant')).toHaveCount(60);
  await expect(page.locator('.thought')).toHaveCount(120);
  await expect(page.locator('.tool-entry')).toHaveCount(60);
  await expect(page.locator('.turn-steps')).toHaveCount(60);
  await expect(page.locator('.turn-steps[open], .turn-steps.live')).toHaveCount(0);
  expect(await page.locator('.turn-steps > summary > .kind').allTextContents()).toEqual(Array(60).fill('3 steps'));
  expect(await page.locator('.turn-steps > summary > .tokens').allTextContents()).not.toContain('');
  const anchors = await page.locator('#messages > [data-anchor-id]').evaluateAll(nodes => nodes.map(n => n.dataset.anchorId));
  expect(new Set(anchors).size).toBe(anchors.length);
  expect(anchors).toContain('user-0:0');
  expect(anchors).toContain('answer-59:0');
  await page.locator('.turn-steps > summary').last().click();
  await expect(page.locator('.thought').last()).toHaveClass(/compact/);
  await expect(page.locator('.thought').last().locator('.body')).toHaveText('Checked item');
});

test('bulk replay and incremental delivery produce the same completed transcript', async ({ page, chat }) => {
  const messages = history(8);
  const view = () => page.locator('#messages').evaluate(root => ({
    users: [...root.querySelectorAll('.message.user .body')].map(n => n.textContent),
    answers: [...root.querySelectorAll('.message.assistant .body')].map(n => n.innerHTML),
    steps: [...root.querySelectorAll('.turn-steps')].map(n => ({
      title: n.querySelector('summary').textContent, open: n.open, live: n.classList.contains('live'),
    })),
    tools: [...root.querySelectorAll('.tool-entry')].map(n => n.textContent),
    anchors: [...root.children].map(n => n.dataset.anchorId || ''),
  }));
  await chat.send(snapshot(messages), { type: 'historyEnd' });
  await frames(page);
  const bulk = await view();
  await chat.send({ type: 'historyReset' }, { type: 'historyEnd' });
  for (const message of messages) await chat.send(snapshot([message]));
  await frames(page);
  expect(await view()).toEqual(bulk);
});

test('restored viewport and live thought updates survive initial detached construction', async ({ page, chat }) => {
  const messages = history(30);
  const live = { id: 'live', type: 'assistant', time: { created: 2000 }, content: [{ type: 'reasoning', text: 'Checking current work' }] };
  messages.push({ id: 'live-user', type: 'user', text: 'Continue', time: { created: 1999 } }, live);
  await chat.send(snapshot(messages), { type: 'historyEnd' });
  await expect(page.locator('.turn-steps.live')).toHaveCount(1);
  await expect(page.locator('.thought.streaming')).toHaveCount(1);
  await page.locator('#messages').evaluate(node => { node.scrollTop = 450; });
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('vscode-state')).viewport?.top)).toBe(450);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.hostMessages.some(m => m.type === 'ready'))).toBe(true);
  await chat.send({ type: 'session', sessionId: 'ses_visual_fixture', cwd: '/workspace', loaded: true },
    snapshot(messages), { type: 'historyEnd' }, { type: 'status', state: 'busy' });
  await expect.poll(() => page.locator('#messages').evaluate(node => Math.abs(node.scrollTop - 450))).toBeLessThan(3);
  await expect(page.locator('.turn-steps.live')).toHaveAttribute('open', '');
  await page.evaluate(() => { window.restoredMessages = document.querySelector('#messages'); });
  live.content[0].text += '\nMore detailed reasoning.';
  live.time.completed = 2001;
  await chat.send(snapshot([live, { id: 'live-idle', type: 'idle', outcome: 'succeeded' }]));
  await expect(page.locator('.thought.streaming')).toHaveCount(0);
  await expect(page.locator('.thought')).toHaveCount(61);
  expect(await page.evaluate(() => window.restoredMessages === document.querySelector('#messages'))).toBe(true);
  await expect.poll(() => page.locator('#messages').evaluate(node => Math.abs(node.scrollTop - 450))).toBeLessThan(3);
  await chat.send({ type: 'historyReset' }, snapshot(history(2)), { type: 'historyEnd' });
  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.locator('.thought')).toHaveCount(4);
});

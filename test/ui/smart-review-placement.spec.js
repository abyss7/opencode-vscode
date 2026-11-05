'use strict';

const { test, expect } = require('./fixture');
const review = (id, toolCallId, extra = {}) => ({ id, toolCallId, sessionID: 'ses_visual_fixture',
  action: 'shell', resource: 'git status', status: 'allow', reason: 'Requested local inspection.', ...extra });
const sendReviews = (chat, ...reviews) => chat.send({ type: 'smartReviews', reviews });
const tool = (chat, toolCallId, extra = {}) => chat.update({ sessionUpdate: 'tool_call', toolCallId,
  kind: 'execute', title: 'git status', rawInput: { command: 'git status' }, status: 'completed', ...extra });
const entry = (page, id) => page.locator(`.tool-entry[data-tool-call-id="${id}"]`);
const answer = (chat, text) => chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

test('late Smart decisions stay inside their completed tool instead of after the answer', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'old-call');
  await answer(chat, 'The inspection is complete.');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn', usage: { totalTokens: 1200 } });
  const tokens = await page.locator('.turn-steps > summary > .tokens').textContent();
  await sendReviews(chat, review('old-review', 'old-call'));
  await expect(entry(page, 'old-call').locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('#messages > .smart-review')).toHaveCount(0);
  await expect(page.locator('.smart-review-history')).toHaveCount(0);
  await expect(page.locator('.turn-steps > summary > .kind')).toHaveText('1 step');
  await expect(page.locator('.turn-steps > summary > .tokens')).toHaveText(tokens);
  await expect(page.locator('.assistant')).toContainText('The inspection is complete.');
  await page.locator('.turn-steps > summary').click();
  await page.locator('.tool-group > summary').click();
  await expect(entry(page, 'old-call').locator('.smart-review')).toBeVisible();
  await chat.snapshot('smart-decision-in-step');
});

test('reviews arriving before tools move to the correct call and update in place', async ({ page, chat }) => {
  const pending = review('review', 'second', { status: 'reviewing', reason: '' });
  await sendReviews(chat, pending);
  await expect(page.locator('.smart-review-history')).toHaveCount(1);
  await expect(page.locator('.smart-review-history')).not.toHaveAttribute('open');
  await page.locator('.smart-review').evaluate((el) => { window.reviewNode = el; });
  await tool(chat, 'first');
  await expect(entry(page, 'first').locator('.smart-review')).toHaveCount(0);
  await tool(chat, 'second', { status: 'in_progress' });
  await expect(entry(page, 'second').locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('.smart-review-history')).toHaveCount(0);
  await sendReviews(chat, review('review', 'second', { status: 'deny', reason: 'Permission was denied.' }));
  await chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'second', status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'Permission denied' } }] });
  await expect(entry(page, 'second').locator('.smart-review')).toContainText('Blocked');
  expect(await page.locator('.smart-review').evaluate((el) => el === window.reviewNode)).toBe(true);
  await expect(page.locator('.smart-review')).toHaveCount(1);
});

test('cached review snapshots reattach during history replay without another poll', async ({ page, chat }) => {
  await tool(chat, 'call');
  const decision = review('review', 'call');
  await sendReviews(chat, decision);
  await chat.send({ type: 'historyReset' });
  await tool(chat, 'unrelated');
  await expect(entry(page, 'unrelated').locator('.smart-review')).toHaveCount(0);
  await tool(chat, 'call');
  await answer(chat, 'Restored answer.');
  await chat.send({ type: 'historyEnd' });
  await expect(entry(page, 'call').locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('.smart-review-history')).toHaveCount(0);
  await sendReviews(chat, decision, decision);
  await expect(page.locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('#messages > .smart-review')).toHaveCount(0);
});

test('identical command text and child IDs do not misassociate decisions', async ({ page, chat }) => {
  await tool(chat, 'call');
  await sendReviews(chat, review('child-review', 'call', { sessionID: 'ses_child' }));
  await expect(entry(page, 'call').locator('.smart-review')).toHaveCount(0);
  await tool(chat, 'ses_child:call');
  await expect(entry(page, 'ses_child:call').locator('.smart-review')).toHaveCount(1);
  await sendReviews(chat, review('root-review', 'ses_visual_fixture:call'));
  await expect(entry(page, 'call').locator('.smart-review')).toHaveCount(1);
  await expect(entry(page, 'ses_child:call').locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('.smart-review-history')).toHaveCount(0);
});

test('late polls bind to an older turn while another turn is active', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'old');
  await answer(chat, 'First answer.');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await chat.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Continue.' } });
  await chat.send({ type: 'status', state: 'busy' });
  await tool(chat, 'current', { status: 'in_progress' });
  await sendReviews(chat, review('review', 'old'));
  await expect(entry(page, 'old').locator('.smart-review')).toHaveCount(1);
  await expect(entry(page, 'current').locator('.smart-review')).toHaveCount(0);
  await expect(page.locator('.turn-steps').first().locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('.turn-steps').last().locator('.smart-review')).toHaveCount(0);
});

test('legacy decisions stay folded until a real tool ID becomes available', async ({ page, chat }) => {
  await tool(chat, 'call');
  await sendReviews(chat, review('legacy', undefined));
  await expect(entry(page, 'call').locator('.smart-review')).toHaveCount(0);
  await expect(page.locator('.smart-review-history')).not.toHaveAttribute('open');
  await expect(page.locator('#messages > .smart-review')).toHaveCount(0);
  await sendReviews(chat, review('legacy', 'call'));
  await expect(entry(page, 'call').locator('.smart-review')).toHaveCount(1);
  await expect(page.locator('.smart-review-history')).toHaveCount(0);
  await chat.send({ type: 'session', sessionId: 'ses_other', cwd: '/workspace' });
  await expect(page.locator('.smart-review')).toHaveCount(0);
});

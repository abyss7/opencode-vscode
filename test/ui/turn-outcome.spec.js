'use strict';

const { test, expect } = require('./fixture');

// The shapes mirror what the server stores when a provider refuses a step:
// the assistant message of that step is empty with `finish: "error"`, and the
// idle marker that follows carries the outcome and the same error.
const quota = {
  type: 'provider.quota', status: 429,
  message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-11-23 21:22:54',
};
const overloaded = { type: 'provider.overloaded', message: 'Server is overloaded' };
const user = (id, text, created) => ({ id, type: 'user', text, time: { created } });
const edit = { type: 'tool', update: { toolCallId: 'call_fix', title: 'Edit file', kind: 'edit',
  status: 'completed', rawInput: { path: 'src/a.js' }, content: [] } };
const step = (id, created, content) => ({ id, type: 'assistant', time: { created, completed: created + 2 }, content });
const failedStep = (id, created, error) => ({ ...step(id, created, []), finish: 'error', error });
const marker = (id, created, outcome, error) => ({ id, type: 'idle', outcome, time: { created }, ...(error ? { error } : {}) });
const snapshot = (messages, states = []) => ({ type: 'transcript', messages, inbox: [], states });
const notices = (page) => page.locator('#messages > :is(.error, .info)');
const QUOTA_NOTICE = 'Turn failed: Usage limit reached for 5 hour. Your limit will reset at 2026-11-23 21:22:54';

test('a turn stopped by the model limit ends with the server error after its steps', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' }, snapshot([
    user('msg_ask', 'Продолжай', 1000),
    step('msg_step', 1001, [
      { type: 'text', text: 'Нашёл: фикстура нарушала инвариант. Ставлю обе базы в начало:' }, edit,
    ]),
  ], [['msg_ask', 'running']]));
  await expect(page.locator('.turn-steps')).toHaveClass(/live/);
  await expect(page.locator('#messages > .error')).toHaveCount(0);

  await chat.send(snapshot([
    failedStep('msg_failed', 1004, quota),
    marker('msg_idle', 1005, 'failed', quota),
  ], [['msg_ask', 'failed']]));
  await expect(page.locator('.turn-steps')).not.toHaveClass(/live/);
  const notice = page.locator('#messages > .error');
  await expect(notice).toHaveText(QUOTA_NOTICE);
  await expect(notice).toHaveAttribute('data-anchor-id', 'msg_idle:0');
  await expect(notice).toBeInViewport();

  // The host's own turn end arrives after the marker and adds nothing.
  await chat.send({ type: 'turnEnd', stopReason: 'error' }, { type: 'status', state: 'ready' });
  await expect(page.locator('#status-text')).toHaveText('Ready');
  await expect(page.locator('#input')).toBeEnabled();
  await expect(notices(page)).toHaveText([QUOTA_NOTICE]);
  expect(await page.locator('#messages').evaluate((root) => root.lastElementChild.className)).toBe('error');
  await chat.snapshot('limit-reached');
});

test('a restored failed turn keeps its marker between the neighbouring prompts', async ({ page, chat }) => {
  const history = () => snapshot([
    user('msg_ask', 'Продолжай', 1000),
    step('msg_step', 1001, [{ type: 'text', text: 'Ставлю обе базы в начало:' }, edit]),
    failedStep('msg_failed', 1004, quota),
    marker('msg_idle', 1005, 'failed', quota),
    user('msg_next', 'Продолжай, где остановился', 2000),
    step('msg_answer', 2001, [{ type: 'text', text: 'Готово.' }]),
    marker('msg_idle_ok', 2003, 'succeeded'),
  ], [['msg_ask', 'failed'], ['msg_next', 'completed']]);
  await chat.send(history(), { type: 'historyEnd' }, { type: 'status', state: 'ready' });
  await expect(notices(page)).toHaveText([QUOTA_NOTICE]);
  expect(await page.locator('#messages').evaluate((root) => [...root.children]
    .filter((node) => node.matches('.message.user, .turn-steps, .error'))
    .map((node) => `${node.className}:${node.dataset.messageId || ''}`))).toEqual([
    'message user:msg_ask', 'turn-steps:', 'error:', 'message user:msg_next',
  ]);
  // A finished turn that follows stays unmarked, and a replay adds no copy.
  await chat.send({ type: 'historyReset' }, history(), { type: 'historyEnd' });
  await expect(notices(page)).toHaveText([QUOTA_NOTICE]);
  await expect(page.locator('.message.assistant .body')).toHaveText(['Ставлю обе базы в начало:', 'Готово.']);
});

test('an interrupted turn and a failure before any output are each marked once', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' }, snapshot([user('msg_ask', 'Долго', 1000)], [['msg_ask', 'running']]));
  await chat.send(snapshot([marker('msg_idle', 1002, 'interrupted')], [['msg_ask', 'interrupted']]));
  await chat.send({ type: 'turnEnd', stopReason: 'cancelled' }, { type: 'status', state: 'ready' });
  const stopped = page.locator('#messages > .info');
  await expect(stopped).toHaveText(['Turn interrupted.']);
  await expect(stopped).toHaveAttribute('data-anchor-id', 'msg_idle:0');
  await expect(page.locator('#messages > .error')).toHaveCount(0);

  await chat.send({ type: 'status', state: 'busy' }, snapshot([user('msg_next', 'Ещё', 2000)], [['msg_next', 'running']]));
  await chat.send(snapshot([
    failedStep('msg_failed', 2001, overloaded),
    marker('msg_idle2', 2002, 'failed', overloaded),
  ], [['msg_next', 'failed']]));
  await chat.send({ type: 'turnEnd', stopReason: 'error' }, { type: 'status', state: 'ready' });
  // Each marker explains its own ending; no generic no-answer notice is added.
  await expect(notices(page)).toHaveText(['Turn interrupted.', 'Turn failed: Server is overloaded']);
  await expect(page.locator('#messages')).not.toContainText('No answer from the model');
  await expect(page.locator('#messages')).not.toContainText('Stopped by user.');
  await chat.snapshot('failed-before-output');
});

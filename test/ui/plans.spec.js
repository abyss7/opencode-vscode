'use strict';

const { test, expect } = require('./fixture');

const plan = (overrides = {}) => ({
  schema: 1, id: 'account-setup', version: 1, title: 'Account setup', kind: 'plan',
  phases: [
    { id: 'p1', title: 'Preparation', tasks: [
      { id: 'p1t1', title: 'Create the account', status: 'done' },
      { id: 'p1t2', title: 'Enable 2FA', status: 'doing', note: 'waiting for SMS' },
    ] },
    { id: 'p2', title: 'Migration', tasks: [
      { id: 'p2t1', title: 'Move keys', status: 'todo' },
    ] },
  ],
  ...overrides,
});

async function answer(chat, value) {
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '```opencode-artifact\n' + JSON.stringify(value) + '\n```' } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
}

test('plans bypass the artifacts panel and post themselves to the host', async ({ page, chat }) => {
  await answer(chat, plan());
  const open = page.getByRole('button', { name: 'Open plan · Account setup · v1' });
  await expect(open).toBeVisible();
  // Plans never enter the generic artifacts panel.
  await expect(page.locator('#artifacts-toggle')).toBeHidden();

  const registered = await chat.received('planArtifact');
  expect(registered.length).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(registered.at(-1).source)).toEqual(plan());

  // History replay does not duplicate host notifications for the same version.
  await chat.send({ type: 'historyReset' });
  await answer(chat, plan());
  await chat.send({ type: 'historyEnd' });
  await expect(open.last()).toBeVisible();
  expect((await chat.received('planArtifact')).length).toBe(registered.length + 1);

  // New versions keep the button current and re-notify the host.
  await answer(chat, plan({ version: 2 }));
  await expect(page.getByRole('button', { name: 'Open plan · Account setup · v2' })).toBeVisible();
  const updated = await chat.received('planArtifact');
  expect(JSON.parse(updated.at(-1).source).version).toBe(2);

  // The button asks the host to reveal the tab; malformed plans stay in chat.
  await page.getByRole('button', { name: 'Open plan · Account setup · v2' }).click();
  expect(await chat.received('openPlan')).toEqual([{ type: 'openPlan', id: 'account-setup' }]);
  await answer(chat, plan({ version: 3, phases: [] }));
  await expect(page.locator('.artifact-reference .visual-error').last()).toContainText('phases');
});

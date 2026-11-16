'use strict';

const { test, expect } = require('./fixture');
const { thoughtTranscript } = require('../../src/thought-transcript');

test('native reasoning completion updates the header and the same transcript block before message end', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  const messages = [
    { id: 'user', type: 'user', text: 'Inspect the export', time: { created: 1 } },
    { id: 'assistant', type: 'assistant', time: { created: 2 }, content: [
      { type: 'reasoning', text: 'Inspecting hash implementation', streamCompleted: true },
      { type: 'reasoning', text: 'Locating namespace for driver', streamCompleted: true },
      { type: 'reasoning', text: 'Auditing input changes' },
    ] },
  ];
  let snapshot = thoughtTranscript(messages, 'session');
  await chat.send({ type: 'transcript', messages: snapshot.messages });
  await expect(page.locator('#status-text')).toHaveText('Locating namespace for driver');
  await expect(page.locator('.thought.streaming')).toHaveCount(1);
  messages[1].content[2].streamCompleted = true;
  snapshot = thoughtTranscript(messages, 'session');
  await chat.send({ type: 'transcript', messages: snapshot.messages });
  await expect(page.locator('#status-text')).toHaveText('Auditing input changes');
  await expect(page.locator('.thought.streaming')).toHaveCount(0);
  await expect(page.locator('.thought')).toHaveCount(3);
  await chat.send({ type: 'historyReset' }, { type: 'status', state: 'busy' },
    { type: 'transcript', messages: snapshot.messages }, { type: 'historyEnd' });
  await expect(page.locator('#status-text')).toHaveText('Auditing input changes');
  await expect(page.locator('.thought')).toHaveCount(3);
  await expect(page.locator('.thought.streaming')).toHaveCount(0);
});

test('generated captions stay separate from source text and cannot overwrite a newer direct thought', async ({ page, chat }) => {
  await chat.send({ type: 'status', state: 'busy' });
  const text = 'Investigating the export dependencies. '.repeat(20);
  const messages = [
    { id: 'user', type: 'user', text: 'Inspect the export', time: { created: 1 } },
    { id: 'assistant', type: 'assistant', time: { created: 2 }, content: [{ type: 'reasoning', text }] },
  ];
  const snapshot = thoughtTranscript(messages, 'session');
  await chat.send({ type: 'transcript', messages: snapshot.messages });
  const summary = { ...snapshot.latest, text: 'Checking export dependencies' };
  await chat.send({ type: 'thoughtCaption', summary });
  await expect(page.locator('#status-text')).toHaveText(summary.text);
  await expect(page.locator('.thought .body')).toHaveText(text.trim());
  messages[1].content.push({ type: 'reasoning', text: 'Writing snapshot validator', streamCompleted: true });
  const complete = thoughtTranscript(messages, 'session');
  await chat.send({ type: 'transcript', messages: complete.messages },
    { type: 'thoughtCaption', summary: { ...summary, text: 'Late obsolete summary' } });
  await expect(page.locator('#status-text')).toHaveText('Writing snapshot validator');
  await page.locator('.thought > summary').first().click();
  await expect(page.locator('.thought').first()).toHaveAttribute('open', '');
  messages[1].content.push({ type: 'reasoning', text: 'Next streaming prefix' });
  await chat.send({ type: 'transcript', messages: thoughtTranscript(messages, 'session').messages });
  await expect(page.locator('.thought').first()).toHaveAttribute('open', '');
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' }, { type: 'thoughtCaption', summary });
  await expect(page.locator('#status-text')).toHaveText('Ready');
});

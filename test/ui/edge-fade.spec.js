'use strict';

const { test, expect } = require('./fixture');

test('the bare header and transcript edges dissolve into the theme background', async ({ page, chat }) => {
  for (let index = 1; index <= 30; index++) {
    await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Line ${index} sinks into the plates' shadow.\n\n` } });
  }
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  // Scroll mid-transcript so the strip covers rendered text. The wheel event
  // hands control to the reader so the transcript controller's follow does
  // not re-park the view mid-assertion.
  await page.locator('#messages').evaluate((node) => {
    node.style.scrollBehavior = 'auto';
    node.scrollTop = Math.round(node.scrollHeight / 2);
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  await expect(page.locator('#header')).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.edge-fade[data-edge="top"]')).toBeVisible();

  const strips = await page.evaluate(() => {
    const workspace = document.getElementById('workspace');
    const bounds = workspace.getBoundingClientRect();
    const messages = document.getElementById('messages');
    const messagesRect = messages.getBoundingClientRect();
    const style = getComputedStyle(messages);
    return {
      paddings: { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) },
      items: [...workspace.querySelectorAll('.edge-fade')].map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          edge: node.dataset.edge,
          // Top strip kisses the workspace top; the bottom strip kisses the
          // scrollport's clip line — where text is actually cut.
          clipGap: node.dataset.edge === 'top'
            ? Math.round(rect.top - bounds.top)
            : Math.round(messagesRect.bottom - rect.bottom),
          height: rect.height,
          width: rect.width,
          pointerEvents: getComputedStyle(node).pointerEvents,
          fade: getComputedStyle(node).backgroundImage,
          beforeContent: getComputedStyle(node, '::before').content,
          afterContent: getComputedStyle(node, '::after').content,
        };
      }),
    };
  });

  // Two strips: the composer plate is an overlay with its own lip for grown
  // states (plate-fade.spec.js), but the scrollport's clip line is fixed by
  // the workspace clearance — the bottom strip rides that line so text sinks
  // into shadow before the clip cuts it. This is the regression the plate
  // overlay introduced: the lip floated in the clearance gap below the clip
  // line and never touched the text.
  expect(strips.items).toHaveLength(2);
  for (const strip of strips.items) {
    expect(strip.clipGap).toBe(0);
    // The immersion never reaches past the scroll padding, so the first and
    // last lines render sharp when scrolled to the ends.
    expect(strip.height).toBeLessThanOrEqual(strips.paddings[strip.edge]);
    expect(strip.width).toBeGreaterThan(300);
    expect(strip.pointerEvents).toBe('none');
    // Both edges fade only into the theme color, without a detached dark band.
    expect(strip.fade).toContain('linear-gradient');
    expect(strip.fade.match(/linear-gradient/g).length).toBe(1);
    // Smooth darkening only: no blur layers, whose masked edge reads as a
    // hard boundary over text.
    expect(strip.beforeContent).toBe('none');
    expect(strip.afterContent).toBe('none');
  };

  // The strips never intercept the pointer: content underneath stays clickable.
  const hit = await page.evaluate(() => {
    const bounds = document.getElementById('workspace').getBoundingClientRect();
    const probe = document.elementFromPoint(bounds.left + 40, bounds.top + 4);
    return probe ? String(probe.className || probe.tagName) : '';
  });
  expect(hit).not.toContain('edge-fade');

  // The immersion visibly changes rendering, not just computed styles.
  const withStrips = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.edge-fade')) node.style.display = 'none';
  });
  const withoutStrips = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.edge-fade')) node.style.display = '';
  });
  expect(withStrips.equals(withoutStrips), 'edge fade strips change rendered pixels').toBe(false);

  // The bottom strip darkens text before the scrollport clips it. Park above
  // the end with a real wheel gesture — the transcript controller owns
  // scrollTop and re-glues plain programmatic writes to the bottom.
  const center = await page.evaluate(() => {
    const rect = document.getElementById('messages').getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  });
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);
  // The reader must be parked above the end so text crosses the clip band.
  const parked = await page.locator('#messages').evaluate((node) => {
    const max = node.scrollHeight - node.clientHeight;
    return { top: node.scrollTop, max };
  });
  expect(parked.top, 'wheel gesture parks the reader above the end').toBeLessThan(parked.max - 30);
  const band = await page.evaluate(() => {
    const messages = document.getElementById('messages').getBoundingClientRect();
    return { x: messages.x, y: messages.bottom - 20, width: messages.width, height: 20 };
  });
  const clipRect = {
    x: Math.round(band.x), y: Math.round(band.y),
    width: Math.round(band.width), height: Math.round(band.height),
  };
  const readScroll = () => page.locator('#messages').evaluate((node) => node.scrollTop);
  const withBottom = await page.screenshot({ clip: clipRect, animations: 'disabled', caret: 'hide' });
  const scrollBefore = await readScroll();
  await page.evaluate(() => {
    document.querySelector('.edge-fade[data-edge="bottom"]').style.display = 'none';
  });
  const withoutBottom = await page.screenshot({ clip: clipRect, animations: 'disabled', caret: 'hide' });
  // The comparison is only meaningful if the view stood still between shots.
  expect(await readScroll(), 'the parked view must not move between shots').toBe(scrollBefore);
  await page.evaluate(() => {
    document.querySelector('.edge-fade[data-edge="bottom"]').style.display = '';
  });
  expect(withBottom.equals(withoutBottom), 'bottom strip darkens text before the clip line').toBe(false);
});

for (const fontSize of [13, 22]) {
test(`a pinned prompt owns the top fade and matches the message bubble (${fontSize}px)`, async ({ page, chat }) => {
  await page.evaluate((size) => document.body.style.setProperty('--vscode-chat-font-size', `${size}px`), fontSize);
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Keep this question visible' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await page.locator('#messages').evaluate((node) => { node.style.scrollBehavior = 'auto'; node.scrollTop = 500; });
  await expect(page.getByRole('button', { name: 'Go to latest prompt' })).toBeVisible();
  await expect(page.locator('.edge-fade[data-edge="top"]')).toBeHidden();

  const shadow = await page.evaluate(() => {
    const sticky = document.querySelector('.sticky-prompt');
    const button = sticky.querySelector('button').getBoundingClientRect();
    const frame = getComputedStyle(sticky.querySelector('button'));
    const style = getComputedStyle(sticky, '::after');
    const viewport = document.getElementById('messages').getBoundingClientRect();
    return {
      visible: sticky.classList.contains('visible'),
      position: style.position,
      display: style.display,
      fade: style.backgroundImage,
      backdropFilter: style.backdropFilter,
      height: parseFloat(style.height),
      marginTop: parseFloat(style.marginTop),
      marginLeft: parseFloat(style.marginLeft),
      buttonTop: button.top,
      viewportTop: viewport.top,
      width: button.width,
      viewportWidth: viewport.width,
      border: frame.borderBottomWidth,
      align: frame.textAlign,
      // Compare against the real message, not a separately hardcoded strip
      // style: all four borders, rounded corners, fill, padding and shadow.
      appearance: (() => {
        const original = getComputedStyle(document.querySelector('.message.user .body'));
        const properties = ['backgroundColor', 'color', 'boxShadow', 'fontFamily', 'fontSize', 'lineHeight',
          ...['Top', 'Right', 'Bottom', 'Left'].flatMap((side) =>
            [`padding${side}`, `border${side}Width`, `border${side}Style`, `border${side}Color`]),
          'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
        return {
          pinned: Object.fromEntries(properties.map((name) => [name, frame[name]])),
          original: Object.fromEntries(properties.map((name) => [name, original[name]])),
        };
      })(),
      pointerEvents: style.pointerEvents,
    };
  });
  expect(shadow.visible).toBe(true);
  // The pseudo-element follows the button in the next grid row, so it cannot
  // cover the frame or drift away when the font changes its height.
  expect(shadow.position).toBe('static');
  expect(shadow.display).toBe('block');
  expect(shadow.marginTop).toBe(0);
  expect(shadow.marginLeft).toBe(-16);
  expect(shadow.height).toBe(16);
  expect(shadow.pointerEvents).toBe('none');
  expect(shadow.fade.match(/linear-gradient/g)).toHaveLength(1);
  expect(shadow.backdropFilter).toBe('none');
  expect(shadow.buttonTop).toBeCloseTo(shadow.viewportTop, 0);
  expect(shadow.width).toBeCloseTo(shadow.viewportWidth - 32, 0);
  expect(shadow.border).toBe('1px');
  expect(shadow.align).toBe('left');
  expect(shadow.appearance.pinned).toEqual(shadow.appearance.original);

  // No fading may touch the pinned button, including its border.
  const button = page.locator('.sticky-prompt button');
  const withFade = await button.screenshot({ animations: 'disabled', caret: 'hide' });
  const noFade = await page.addStyleTag({ content: '.sticky-prompt::after { display: none !important; }' });
  const withoutFade = await button.screenshot({ animations: 'disabled', caret: 'hide' });
  expect(withFade.equals(withoutFade), 'the pinned frame and text stay untouched by the fade').toBe(true);
  await noFade.evaluate((node) => node.remove());

  // The prompt stays flush as scrolling continues; returning to the beginning
  // restores the header fade instead of leaving the transcript without one.
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 900; });
  await expect.poll(async () => (await button.boundingBox()).y).toBeCloseTo(shadow.viewportTop, 0);
  await expect(page.locator('.edge-fade[data-edge="top"]')).toBeHidden();
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 0; });
  await expect(button).toBeHidden();
  await expect(page.locator('.edge-fade[data-edge="top"]')).toBeVisible();
});
}

test('top fades respect high contrast and reduced transparency', async ({ page, chat }) => {
  await chat.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Keep this question visible' } });
  await chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long answer.\n\n'.repeat(100) } });
  await chat.send({ type: 'turnEnd', stopReason: 'end_turn' });
  await expect(page.getByRole('button', { name: 'Go to latest prompt' })).toBeVisible();
  for (const theme of ['vscode-high-contrast', 'vscode-high-contrast-light']) {
    await page.evaluate((name) => document.body.classList.add(name), theme);
    expect(await page.locator('.sticky-prompt').evaluate((node) => getComputedStyle(node, '::after').display)).toBe('none');
    await page.locator('#messages').evaluate((node) => { node.scrollTop = 0; });
    await expect(page.locator('.edge-fade[data-edge="top"]')).toBeHidden();
    await page.evaluate((name) => document.body.classList.remove(name), theme);
    await page.locator('#messages').evaluate((node) => { node.scrollTop = 500; });
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  expect(await page.locator('.sticky-prompt').evaluate((node) => getComputedStyle(node, '::after').display)).toBe('none');
  await page.locator('#messages').evaluate((node) => { node.scrollTop = 0; });
  await expect(page.locator('.edge-fade[data-edge="top"]')).toBeHidden();
});

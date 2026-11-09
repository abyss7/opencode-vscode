'use strict';

const { scrollToElement, focusWithoutScroll } = require('./scroll');

let sequence = 0;
function outline(root) {
  const headings = [...root.querySelectorAll('h1, h2, h3')];
  if (headings.length < 4) return;
  const nav = document.createElement('details');
  nav.className = 'answer-outline';
  const summary = document.createElement('summary');
  summary.textContent = `On this page (${headings.length})`;
  nav.append(summary);
  const list = document.createElement('nav');
  list.setAttribute('aria-label', 'Answer outline');
  for (const heading of headings) {
    heading.id ||= `answer-heading-${++sequence}`;
    heading.tabIndex = -1;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = heading.textContent;
    button.dataset.level = heading.tagName.slice(1);
    button.addEventListener('click', () => {
      scrollToElement(heading.closest('.messages, #artifacts'), heading, { block: 'start' });
      focusWithoutScroll(heading);
    });
    list.append(button);
  }
  nav.append(list);
  root.prepend(nav);
}

module.exports = { outline };

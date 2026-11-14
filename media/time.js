'use strict';

/**
 * Wall-clock formatting shared by every webview and the extension host.
 * Always 24-hour, day before month, fixed English month and weekday names —
 * never the surrounding locale, so no AM/PM and no month-first dates anywhere.
 *
 *   formatTimestamp(ts, { seconds }) — contextual caption:
 *     today 13:30 · yesterday 23:59 · tomorrow 09:15 · Tue 00:30 ·
 *     20 Dec 13:04 · 20 Dec 2025 13:04
 *   formatDay(ts) — sidebar date: 25 Dec, last year 20 Dec 2025
 *   formatFull(ts) — unambiguous title: Wed 31 Dec 2025, 23:59:58
 */
(function (global) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function parse(timestamp) {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function two(value) {
    return String(value).padStart(2, '0');
  }

  function clock(date, seconds) {
    const base = `${two(date.getHours())}:${two(date.getMinutes())}`;
    return seconds ? `${base}:${two(date.getSeconds())}` : base;
  }

  /** Whole calendar days between two local dates, DST-safe. */
  function dayDistance(a, b) {
    const start = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.round((start(a) - start(b)) / 86400000);
  }

  function formatTimestamp(timestamp, options = {}) {
    const date = parse(timestamp);
    if (!date) return '';
    const now = parse(options.now) || new Date();
    const seconds = options.seconds === true;
    const days = dayDistance(date, now);
    // `today: false` drops the word for same-day stamps: the clock alone is
    // enough when the context already says "resets …".
    if (days === 0) {
      const time = clock(date, seconds);
      return options.today === false ? time : `today ${time}`;
    }
    if (days === -1) return `yesterday ${clock(date, seconds)}`;
    if (days === 1) return `tomorrow ${clock(date, seconds)}`;
    if (Math.abs(days) <= 6) return `${WEEKDAYS[date.getDay()]} ${clock(date, seconds)}`;
    const datePart = [date.getDate(), MONTHS[date.getMonth()]];
    if (date.getFullYear() !== now.getFullYear()) datePart.push(String(date.getFullYear()));
    return `${datePart.join(' ')} ${clock(date, seconds)}`;
  }

  function formatDay(timestamp, options = {}) {
    const date = parse(timestamp);
    if (!date) return '';
    const now = parse(options.now) || new Date();
    const parts = [date.getDate(), MONTHS[date.getMonth()]];
    if (date.getFullYear() !== now.getFullYear()) parts.push(String(date.getFullYear()));
    return parts.join(' ');
  }

  function formatFull(timestamp) {
    const date = parse(timestamp);
    if (!date) return '';
    return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${clock(date, true)}`;
  }

  const api = { formatTimestamp, formatDay, formatFull };
  global.OpenCodeTime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

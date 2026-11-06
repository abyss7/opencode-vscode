'use strict';

const http = require('node:http');
const https = require('node:https');

// The event feed is live-only. Every connection (including a reconnect) must
// be followed by a snapshot; neither event IDs nor Last-Event-ID imply replay.
class ServerEvents {
  constructor(api, handlers) {
    this.api = api;
    this.handlers = handlers;
    this.closed = false;
    this.delay = 250;
  }

  start() {
    this.connect();
  }

  async connect() {
    let ended = false;
    const failed = (error) => {
      if (ended || this.closed) return;
      ended = true;
      this.request?.destroy();
      this.handlers.disconnected(error);
      this.api._server = null;
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 10000);
      this.timer.unref?.();
    };
    try {
      const server = await this.api._resolveServer();
      if (this.closed) return;
      const url = new URL('/api/event', server.url);
      const headers = { accept: 'text/event-stream' };
      if (server.password) headers.authorization = 'Basic ' +
        Buffer.from(`opencode:${server.password}`).toString('base64');
      this.request = (url.protocol === 'https:' ? https : http).get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          failed(new Error(`Event subscription: HTTP ${res.statusCode}`));
          return;
        }
        this.delay = 250;
        let buffer = '';
        let data = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (ended || this.closed) return;
          buffer += chunk;
          if (buffer.length > 8 * 1024 * 1024) return failed(new Error('Event frame too large'));
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            else if (!line && data.length) {
              try { this.handlers.event(JSON.parse(data.join('\n'))); }
              catch (error) { failed(error); return; }
              data = [];
            }
          }
        });
        res.on('end', () => failed(new Error('Event stream ended')));
        res.on('error', failed);
        res.on('aborted', () => failed(new Error('Event stream interrupted')));
        this.handlers.connected();
      });
      this.request.on('error', failed);
      this.request.setTimeout(90000, () => failed(new Error('Event stream timed out')));
    } catch (error) { failed(error); }
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.request?.destroy();
  }
}

module.exports = { ServerEvents };

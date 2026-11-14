'use strict';

/**
 * @file Webview HTML shell assembly for a session chat tab.
 *
 * Injects the per-tab CSP nonce, resolved webview resource URIs, and the inert
 * `<template id="provider-icons">` SVG sprite sheet (required inline because
 * Chromium blocks cross-origin `<svg><use>` references inside VS Code webviews).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
const HTML_PATH = path.join(MEDIA_DIR, 'chat.html');
const PROVIDER_ICONS_PATH = path.join(MEDIA_DIR, 'provider-icons.svg');

function buildHtml(webview, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const assetUri = (file) => String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)));

  return fs
    .readFileSync(HTML_PATH, 'utf8')
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{timeUri\}\}/g, assetUri('time.js'))
    .replace('{{providerIcons}}', () => fs.readFileSync(PROVIDER_ICONS_PATH, 'utf8'))
    .replace(/\{\{richTextUri\}\}/g, assetUri('rich-text.js'))
    .replace(/\{\{richTextStyleUri\}\}/g, assetUri('rich-text.css'))
    .replace(/\{\{diagramsUri\}\}/g, assetUri('diagrams.js'))
    .replace(/\{\{modelPickerUri\}\}/g, assetUri('model-picker.js'))
    .replace(/\{\{styleUri\}\}/g, assetUri('chat.css'))
    .replace(/\{\{scriptUri\}\}/g, assetUri('chat.js'));
}

module.exports = { buildHtml };

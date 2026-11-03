'use strict';

const vscode = require('vscode');

async function exportArtifact(message) {
  if (typeof message.content !== 'string' || message.content.length > 16000000) return;
  const name = String(message.name || 'artifact.json').replace(/[^\w.-]/g, '_');
  const uri = await vscode.window.showSaveDialog({ title: `Export ${name}`, saveLabel: 'Export', filters: { JSON: ['json'] } });
  if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(message.content, 'utf8'));
}

module.exports = { exportArtifact };

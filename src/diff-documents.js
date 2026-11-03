'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');

// One provider per panel; immutable virtual documents never touch workspace files.
class DiffDocuments {
  constructor() {
    this.scheme = `opencode-diff-${crypto.randomBytes(8).toString('hex')}`;
    this.documents = new Map();
    this.sequence = 0;
    this.provider = vscode.workspace.registerTextDocumentContentProvider(this.scheme, {
      provideTextDocumentContent: (uri) => this.documents.get(uri.toString()) ?? '',
    });
  }

  async open(change) {
    if (typeof change.newText !== 'string' || (change.oldText != null && typeof change.oldText !== 'string')) return;
    const name = path.basename(String(change.path || 'change.txt'));
    const id = ++this.sequence;
    const make = (side, text) => {
      const uri = vscode.Uri.from({ scheme: this.scheme, path: `/${id}/${side}/${name}` });
      this.documents.set(uri.toString(), text);
      return uri;
    };
    const before = make('before', change.oldText ?? '');
    const after = make('after', change.newText);
    await vscode.commands.executeCommand('vscode.diff', before, after, `${name} — tool change`, {
      viewColumn: vscode.ViewColumn.Beside, preview: false,
    });
  }

  dispose() {
    this.provider.dispose();
    this.documents.clear();
  }
}

module.exports = { DiffDocuments };

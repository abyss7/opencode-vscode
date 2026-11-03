'use strict';

const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const common = {
  absWorkingDir: root,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome108',
  minify: true,
  legalComments: 'linked',
  metafile: true,
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  assetNames: 'fonts/[name]-[hash]',
};

async function build() {
  const results = await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/webview/rich-text.js'], outfile: 'media/rich-text.js',
      globalName: 'OpenCodeRichText', footer: { js: 'if (typeof module !== "undefined") module.exports = OpenCodeRichText;' } }),
    esbuild.build({ ...common, entryPoints: ['src/webview/diagrams.js'], outfile: 'media/diagrams.js', globalName: 'OpenCodeDiagrams' }),
  ]);
  const packages = new Set();
  for (const result of results) {
    for (const input of Object.keys(result.metafile.inputs)) {
      const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if (match) packages.add(match[1]);
    }
  }
  const notices = [];
  for (const directory of [...packages].sort()) {
    const folder = path.join(root, directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const licenses = fs.readdirSync(folder).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name) && fs.statSync(path.join(folder, name)).isFile());
    notices.push(`${pkg.name} ${pkg.version} (${pkg.license || 'see license'})\n` + licenses.sort().map((name) => fs.readFileSync(path.join(folder, name), 'utf8')).join('\n'));
  }
  fs.writeFileSync(path.join(root, 'media/THIRD_PARTY_LICENSES.txt'), notices.join('\n\n---\n\n'));
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

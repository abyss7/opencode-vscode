'use strict';

/**
 * Builds the release VSIX from a staging copy of the extension.
 *
 * VS Code renders the model dropdown from `contributes.configuration` in
 * `package.json`, and the extension rewrites that list at startup from the
 * local OpenCode catalogue. A checkout in which the extension has run therefore
 * carries the author's providers and models, which must not end up in a
 * release. The staging copy has the runtime list removed, and every user gets
 * their own catalogue on the first start.
 *
 * Usage: node scripts/package.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const IGNORE_FILE = path.join(ROOT, '.vscodeignore');
const RUNTIME_ENUMS = ['opencode.model'];
const RUNTIME_KEYS = ['enum', 'enumDescriptions', 'markdownEnumDescriptions'];

function readExclusions() {
  return fs
    .readFileSync(IGNORE_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function isExcluded(relative, patterns) {
  const name = path.basename(relative);
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const directory = pattern.slice(0, -3);
      return relative === directory || relative.startsWith(`${directory}${path.sep}`);
    }
    if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
    return relative === pattern;
  });
}

function copyTree(source, target, patterns) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const relative = path.relative(ROOT, from);
    if (isExcluded(relative, patterns)) continue;
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to, patterns);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function configurationProperties(pkg) {
  const configuration = pkg.contributes && pkg.contributes.configuration;
  if (!configuration) return [];
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  return sections
    .map((section) => section && section.properties)
    .filter((properties) => properties && typeof properties === 'object');
}

function stripRuntimeEnums(file) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const properties of configurationProperties(pkg)) {
    for (const id of RUNTIME_ENUMS) {
      const property = properties[id];
      if (!property) continue;
      for (const key of RUNTIME_KEYS) delete property[key];
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

function main() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-vsix-'));
  try {
    copyTree(ROOT, staging, readExclusions());
    const packageFile = path.join(staging, 'package.json');
    stripRuntimeEnums(packageFile);
    const { version } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const output = path.join(ROOT, `opencode-sessions-${version}.vsix`);
    fs.rmSync(output, { force: true });
    execFileSync('npx', ['--yes', '@vscode/vsce@3', 'package', '--out', output], {
      cwd: staging,
      stdio: 'inherit',
      env: process.env,
    });
    console.log(`Packaged ${path.relative(ROOT, output)}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main();

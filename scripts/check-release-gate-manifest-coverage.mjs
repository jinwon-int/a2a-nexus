#!/usr/bin/env node
/**
 * Release-gate manifest absence sweep (#1261 L1 / #1270 L2).
 *
 * Fails closed when a test under scripts/*.test.mjs or scripts/lib/*.test.mjs is
 * not represented by the legacy release-gate manifest, the tier inventory, or a
 * package/inventory command for the corresponding implementation script. This
 * catches the silent "new test file exists but no gate runs it" class without
 * adding another root npm script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_SCAN_DIRS = ['scripts', 'scripts/lib'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isTestFile(name) {
  return name.endsWith('.test.mjs');
}

function implementationPeer(testPath) {
  return testPath.replace(/\.test\.mjs$/, '.mjs');
}

function tokenize(command) {
  if (typeof command !== 'string') return [];
  const tokens = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function relFromToken(token) {
  if (typeof token !== 'string') return '';
  const cleaned = token.replace(/^['"]|['"]$/g, '');
  return /^(scripts|test|scanner)\/.+\.mjs$/.test(cleaned) ? cleaned : '';
}

export function discoverScriptTests(repoRoot = REPO_ROOT, scanDirs = DEFAULT_SCAN_DIRS) {
  const discovered = [];
  for (const dir of scanDirs) {
    const absolute = path.join(repoRoot, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !isTestFile(entry.name)) continue;
      discovered.push(path.posix.join(dir, entry.name));
    }
  }
  return discovered.sort();
}

function collectManifestFiles(repoRoot) {
  const manifestPath = path.join(repoRoot, 'scripts/release-gate-manifest.json');
  if (!fs.existsSync(manifestPath)) return new Set();
  const manifest = readJson(manifestPath);
  const files = new Set();
  for (const entry of Array.isArray(manifest.entries) ? manifest.entries : []) {
    if (typeof entry?.file === 'string') files.add(entry.file);
  }
  return files;
}

function addCommandTokens(files, command, args = []) {
  for (const token of [command, ...args]) {
    const rel = relFromToken(token);
    if (rel) files.add(rel);
  }
  for (const token of tokenize([command, ...args].filter(Boolean).join(' '))) {
    const rel = relFromToken(token);
    if (rel) files.add(rel);
  }
}

function collectInventoryFiles(repoRoot) {
  const inventoryPath = path.join(repoRoot, 'docs/ops/release-gate-step-inventory.json');
  const files = new Set();
  if (!fs.existsSync(inventoryPath)) return files;
  const inventory = readJson(inventoryPath);
  for (const entry of Array.isArray(inventory.entries) ? inventory.entries : []) {
    addCommandTokens(files, entry.command, Array.isArray(entry.args) ? entry.args : []);
  }
  return files;
}

function collectPackageScriptFiles(repoRoot) {
  const files = new Set();
  const packages = ['package.json'];
  for (const rel of packages) {
    const pkgPath = path.join(repoRoot, rel);
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    for (const command of Object.values(pkg.scripts ?? {})) {
      addCommandTokens(files, undefined, tokenize(command));
    }
  }
  return files;
}

function isCovered(testPath, registeredFiles) {
  if (registeredFiles.has(testPath)) return true;
  return registeredFiles.has(implementationPeer(testPath));
}

export function evaluateReleaseGateManifestCoverage(repoRoot = REPO_ROOT) {
  const discovered = discoverScriptTests(repoRoot);
  const releaseGateManifest = collectManifestFiles(repoRoot);
  const inventory = collectInventoryFiles(repoRoot);
  const packageScripts = collectPackageScriptFiles(repoRoot);
  const registered = new Set([...releaseGateManifest, ...inventory, ...packageScripts]);
  const missing = discovered.filter((file) => !isCovered(file, registered));
  return {
    ok: missing.length === 0,
    discovered,
    missing,
    counts: {
      discovered: discovered.length,
      releaseGateManifest: releaseGateManifest.size,
      inventory: inventory.size,
      packageScripts: packageScripts.size,
      missing: missing.length,
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', short: 'r' },
      json: { type: 'boolean' },
    },
  });
  const repoRoot = path.resolve(values.root ?? process.cwd());
  const result = evaluateReleaseGateManifestCoverage(repoRoot);
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `release-gate manifest coverage: discovered=${result.counts.discovered} missing=${result.counts.missing}`,
    );
    if (result.missing.length) {
      console.error('release-gate manifest coverage: unregistered test file(s):');
      for (const file of result.missing) console.error(`  ${file}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

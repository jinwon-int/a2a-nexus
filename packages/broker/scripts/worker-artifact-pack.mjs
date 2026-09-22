#!/usr/bin/env node
// Worker artifact packer — assemble a deploy-ready worker artifact with its
// WORKSPACE dependencies baked in (a2a-nexus#2227 제안 1).
//
// Why: handler 0.2.20 imported the workspace package a2a-attestation, but the
// artifact is built by copying packages/broker/scripts files, so the package
// never shipped — the handler died on startup with ERR_MODULE_NOT_FOUND while
// every path/marker/policy guard passed. File-copy sync breaks again every
// time a workspace package is added. This tool closes that structurally:
// it scans the payload's import graph for bare specifiers, maps them to
// workspace packages, and copies each needed package (package.json + build
// output) into <artifact>/node_modules/<name>. The rollout guard's
// `handler-module-resolution` smoke (#2229) is the deploy-time gate that
// proves the result.
//
// Usage:
//   node scripts/worker-artifact-pack.mjs --out <artifact-root> [--verbose]
//   node scripts/worker-artifact-pack.mjs --out <artifact-root> --check   # plan only, no writes
//   A2A_PACK_REPO_ROOT=<repo> node scripts/worker-artifact-pack.mjs …    # override repo root (tests)
//
// What it writes under --out:
//   scripts/*.mjs, scripts/lib/*.mjs        payload copied from packages/broker/scripts (*.test.mjs excluded)
//   handlers/*.mjs, handlers/lib/*.mjs      byte-identical runtime compat copies (guard compareCompatFile contract)
//   dist/<runtime closure>                  compiled files the handler entry reaches via ../dist/… imports
//                                           (packages/broker/dist build output — closure, not the whole 12 MB tree)
//   node_modules/<workspace-package>/        package.json + dist/ for every transitively needed workspace package
//
// Exit codes: 0 ok · 1 packing failure (e.g. missing dist) · 2 usage error.
// The JSON summary on stdout lists packed workspaces and any EXTERNAL (npm)
// bare imports found — external deps are reported, never guessed: pre-seed
// them in the artifact's node_modules yourself if a payload file needs one.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');
const CHECK_ONLY = process.argv.includes('--check');

function outFlag() {
  const i = process.argv.indexOf('--out');
  if (i === -1 || !process.argv[i + 1]) return null;
  return resolve(process.argv[i + 1]);
}

// Repo root: this script lives at <repo>/packages/broker/scripts (three levels
// below the repo). Tests may relocate the whole layout and point at it via
// A2A_PACK_REPO_ROOT.
const repoRoot = process.env.A2A_PACK_REPO_ROOT
  ? resolve(process.env.A2A_PACK_REPO_ROOT)
  : resolve(scriptDir, '..', '..', '..');

const payloadSourceDir = join(repoRoot, 'packages', 'broker', 'scripts');

function fail(message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...detail }, null, 2)}\n`);
  process.exit(1);
}

if (!outFlag()) {
  process.stderr.write('usage: worker-artifact-pack.mjs --out <artifact-root> [--check] [--verbose]\n');
  process.exit(2);
}
const artifactRoot = outFlag();

if (!existsSync(join(payloadSourceDir, 'a2a-task-handler.mjs'))) {
  fail(`payload source not found: ${payloadSourceDir}`, { repoRoot });
}

// ---------------------------------------------------------------------------
// workspace package index
// ---------------------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Map workspace package name → package directory. */
function indexWorkspacePackages() {
  const map = new Map();
  const rootPkg = readJson(join(repoRoot, 'package.json')) ?? {};
  const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  for (const glob of globs) {
    if (!glob.endsWith('/*')) {
      const dir = join(repoRoot, glob);
      const pkg = readJson(join(dir, 'package.json'));
      if (pkg?.name) map.set(pkg.name, dir);
      continue;
    }
    const parent = join(repoRoot, glob.slice(0, -1));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const pkgPath = join(parent, entry, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      if (pkg?.name && !map.has(pkg.name)) map.set(pkg.name, join(parent, entry));
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// import-graph scan
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"\n]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"\n]+)['"]/g,
  // 동적 import의 specifier는 한 줄 안의 문자열 리터럴만 본다 — 여러 줄에 걸쳐
  // 문자열 조립으로 import()를 만드는 코드(guard의 해소 프로브 등)는 정적 스캔이
  // 볼 수 있는 대상이 아니며, 줄을 건너 캡처하면 오탐만 남는다.
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Bare specifier → package name ('@a/b' keeps both segments; node:/relative excluded). */
function bareSpecifierName(spec) {
  if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) return null;
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function scanBareImports(content) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const name = bareSpecifierName(match[1]);
      if (name) found.add(name);
    }
  }
  return [...found];
}

function listJsFiles(dir, into = []) {
  if (!existsSync(dir)) return into;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listJsFiles(full, into);
    else if (/\.(js|mjs|cjs)$/.test(entry)) into.push(full);
  }
  return into;
}

// ---------------------------------------------------------------------------
// packing
// ---------------------------------------------------------------------------

const PAYLOAD_EXCLUDE = /(^|[\\/])[^\\/]*\.test\.mjs$/;
const writtenFiles = [];
const externalDeps = new Set();

function writeFile(src, dest) {
  if (CHECK_ONLY) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  writtenFiles.push(relative(artifactRoot, dest));
}

function packWorkspacePackage(name, workspaces, packed) {
  if (packed.has(name)) return;
  packed.add(name);

  const dir = workspaces.get(name);
  const distDir = join(dir, 'dist');
  if (!existsSync(distDir)) {
    fail(`workspace package "${name}" has no build output (dist/ missing)`, {
      packageDir: dir,
      hint: `run \`npm run build -w ${name}\` in the repo, then re-run the packer — a file-copy artifact cannot resolve this package without its dist (#2227)`,
    });
  }

  const pkgJson = join(dir, 'package.json');
  writeFile(pkgJson, join(artifactRoot, 'node_modules', name, 'package.json'));
  for (const file of listJsFiles(distDir)) {
    writeFile(file, join(artifactRoot, 'node_modules', name, 'dist', relative(distDir, file)));
  }
  if (VERBOSE) console.error(`[pack] workspace ${name} ← ${relative(repoRoot, dir)}`);

  // Transitive: what the packed package itself imports at runtime.
  const seen = new Set();
  for (const file of [pkgJson, ...listJsFiles(distDir)]) {
    const content = readFileSync(file, 'utf8');
    for (const spec of scanBareImports(content)) {
      if (workspaces.has(spec)) packWorkspacePackage(spec, workspaces, packed);
      else seen.add(spec);
    }
  }
  for (const spec of seen) externalDeps.add(`${name} → ${spec}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const workspaces = indexWorkspacePackages();

// 1. Payload: every non-test .mjs under packages/broker/scripts (+ lib/).
const payloadFiles = [];
for (const file of listJsFiles(payloadSourceDir)) {
  if (!file.endsWith('.mjs') || PAYLOAD_EXCLUDE.test(file)) continue;
  if (file === join(payloadSourceDir, 'worker-artifact-pack.mjs')) continue; // repo-side tool, not payload
  payloadFiles.push(file);
}
payloadFiles.sort();

for (const src of payloadFiles) {
  const rel = relative(payloadSourceDir, src);
  writeFile(src, join(artifactRoot, 'scripts', rel));
  writeFile(src, join(artifactRoot, 'handlers', rel)); // runtime compat copy — byte-identical by construction
}

// 2. Workspace deps of the payload graph.
const packed = new Set();
for (const src of payloadFiles) {
  const content = readFileSync(src, 'utf8');
  for (const spec of scanBareImports(content)) {
    if (workspaces.has(spec)) packWorkspacePackage(spec, workspaces, packed);
    else externalDeps.add(`payload → ${spec}`);
  }
}

// 3. Compiled dist closure. The handler imports compiled broker code via
//    `../dist/…` (from scripts/) — the same path resolves to <artifact>/dist/…
//    from the handlers/ runtime copy. Ship exactly the reachable subset:
//    the whole dist tree is ~12 MB and drags in server-only npm deps the
//    worker never loads.
const brokerDistRoot = join(repoRoot, 'packages', 'broker', 'dist');
const distClosure = new Set();
const distExternal = new Set();

function collectFromDistFile(file) {
  const content = readFileSync(file, 'utf8');
  for (const spec of scanBareImports(content)) {
    if (workspaces.has(spec)) packWorkspacePackage(spec, workspaces, packed);
    else distExternal.add(`${relative(brokerDistRoot, file)} → ${spec}`);
  }
  // relative imports stay inside dist
  const relSpecs = content.match(/from\s*['"](\.[^'\n]+)['"]|import\s*\(\s*['"](\.[^'\n]+)['"]\s*\)/g) ?? [];
  for (const raw of relSpecs) {
    const spec = raw.match(/['"]([^'\n]+)['"]/)[1];
    const target = resolve(dirname(file), spec);
    if (!target.startsWith(brokerDistRoot) || !existsSync(target)) continue;
    if (!distClosure.has(target)) {
      distClosure.add(target);
      collectFromDistFile(target);
    }
  }
}

const handlerEntryContent = readFileSync(join(payloadSourceDir, 'a2a-task-handler.mjs'), 'utf8');
const distSeeds = [];
for (const raw of handlerEntryContent.matchAll(/['"](\.\.\/dist\/[^'\n]+)['"]/g)) {
  distSeeds.push(resolve(payloadSourceDir, raw[1]));
}
for (const seed of distSeeds) {
  if (!existsSync(seed)) {
    fail(`handler imports compiled dist file that does not exist: ${seed}`, {
      hint: 'run `npm run build` in packages/broker, then re-run the packer (#2227)',
    });
  }
  if (!distClosure.has(seed)) {
    distClosure.add(seed);
    collectFromDistFile(seed);
  }
}
for (const file of distClosure) {
  writeFile(file, join(artifactRoot, 'dist', relative(brokerDistRoot, file)));
}
for (const spec of distExternal) externalDeps.add(spec);

const summary = {
  ok: true,
  checkOnly: CHECK_ONLY,
  artifactRoot,
  payloadFiles: payloadFiles.length,
  handlersMirror: CHECK_ONLY ? 0 : payloadFiles.length,
  writtenFiles: CHECK_ONLY ? undefined : writtenFiles.length,
  distClosureFiles: distClosure.size,
  packedWorkspaces: [...packed].sort(),
  externalDeps: [...externalDeps].sort(),
  verify: `A2A_WORKER_ROOT=${artifactRoot} node ${join(payloadSourceDir, 'worker-artifact-rollout-guard.mjs')} --deployed`,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

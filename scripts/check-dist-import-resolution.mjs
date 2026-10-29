#!/usr/bin/env node
/**
 * Resolve every compiled-output import specifier used by operator scripts (#1601).
 *
 * Operator `.mjs` scripts consume broker behaviour through compiled paths such
 * as `../dist/core/a2a-dispatch-helper.js`. Nothing verified those paths.
 * The broker test manifest checks these scripts with `node --check`, which only
 * *parses* a file — it never resolves an import — so a specifier can point at a
 * module that does not exist and every gate in the repository stays green while
 * the script crashes with ERR_MODULE_NOT_FOUND the moment an operator runs it.
 *
 * That is not hypothetical. When `terminal-brief-sidecar-default-on/` became a
 * subdirectory, seventeen scripts kept importing the old flat paths and were
 * dead from that commit onward, undetected.
 *
 * This gate resolves each specifier against the *source* tree rather than
 * `dist/`, by mapping `<pkg>/dist/<path>.js` back to `<pkg>/src/<path>.ts`. That
 * keeps it build-free, so it runs in the fast check lane and cannot be silently
 * skipped by a missing build. A specifier also passes if the compiled file
 * happens to exist on disk, which keeps the gate honest for generated output
 * that has no TypeScript source.
 *
 * Test files are scanned too, deliberately: the same rot muted a conformance
 * round-trip in scripts/verify-analysis-report.test.mjs, where a stale
 * specifier turned a permanent resolution failure into a permanent skip. If a
 * test needs to write fixture code containing a compiled-output import, build
 * the specifier by interpolation (`${dist}/thing.js`) so it is not a literal in
 * the scanned file — that keeps the guard exclusion-free.
 *
 * Safety: read-only path resolution. Nothing is imported or executed. No
 * release, publish, visibility, live dispatch, restart, credential, DB, or
 * Terminal ACK action is performed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocCheckContext } from './lib/doc-check.mjs';

/** Directories whose *.mjs/*.js files are scanned for compiled-output imports. */
export const SCRIPT_DIRS = ['scripts', 'packages/broker/scripts'];

/**
 * Compiled files with no TypeScript source, which therefore cannot be resolved
 * through the dist -> src mapping. Keep this empty unless a generated artifact
 * is genuinely imported; every entry is a hole in the gate.
 */
export const GENERATED_OUTPUT_ALLOWLIST = [];

const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

/** Extract relative import specifiers that point into a compiled output tree. */
export function extractDistSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    if (!/(^|\/)dist\//.test(specifier)) continue;
    if (!specifier.endsWith('.js')) continue;
    found.push(specifier);
  }
  return found;
}

/**
 * Map a resolved compiled path back to its TypeScript source path.
 * Returns null when the path contains no `dist` segment.
 */
export function distPathToSourcePath(distPath) {
  const segments = distPath.split(path.sep);
  const index = segments.lastIndexOf('dist');
  if (index === -1) return null;
  const mapped = [...segments];
  mapped[index] = 'src';
  const joined = mapped.join(path.sep);
  return joined.replace(/\.js$/, '.ts');
}

/**
 * True when a resolved path names build output of a real workspace, i.e. the
 * directory holding `dist` also holds a package.json.
 *
 * This is what separates a genuine compiled-output import from code that merely
 * looks like one. `packages/broker/scripts/release-gate.mjs` embeds
 * `import ... from './dist/core/store.js'` inside a template literal that is
 * executed inside a container, where the working directory is the package root
 * — not the scripts directory. Resolving it here would yield
 * `packages/broker/scripts/dist/...`, which is not any workspace's output, so
 * the gate correctly declines to rule on it.
 */
export function isWorkspaceDistPath(resolvedPath, exists) {
  const segments = resolvedPath.split(path.sep);
  const index = segments.lastIndexOf('dist');
  if (index <= 0) return false;
  const packageRoot = segments.slice(0, index).join(path.sep);
  return exists(path.join(packageRoot, 'package.json'));
}

/**
 * Decide whether one specifier resolves. Pure so the ruling can be tested
 * against synthetic trees.
 */
export function resolveSpecifier(scriptFile, specifier, exists) {
  const resolved = path.resolve(path.dirname(scriptFile), specifier);
  if (exists(resolved)) return { ok: true, via: 'compiled output' };
  if (!isWorkspaceDistPath(resolved, exists)) return { ok: true, via: 'not workspace output' };

  const sourcePath = distPathToSourcePath(resolved);
  if (sourcePath && exists(sourcePath)) return { ok: true, via: 'source' };

  const indexPath = sourcePath ? sourcePath.replace(/\.ts$/, `${path.sep}index.ts`) : null;
  if (indexPath && exists(indexPath)) return { ok: true, via: 'source index' };

  return { ok: false, resolved, sourcePath };
}

/** List *.mjs and *.js files directly inside a directory. */
function listScriptFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')))
    .map((entry) => path.join(dir, entry.name));
}

export function collectUnresolved(root, { scriptDirs = SCRIPT_DIRS, exists = fs.existsSync } = {}) {
  const allowed = new Set(GENERATED_OUTPUT_ALLOWLIST);
  const unresolved = [];
  let checked = 0;

  for (const dir of scriptDirs) {
    for (const scriptFile of listScriptFiles(path.join(root, dir))) {
      let source;
      try {
        source = fs.readFileSync(scriptFile, 'utf8');
      } catch {
        continue;
      }
      for (const specifier of extractDistSpecifiers(source)) {
        const relScript = path.relative(root, scriptFile);
        if (allowed.has(`${relScript}::${specifier}`)) continue;
        checked += 1;
        const ruling = resolveSpecifier(scriptFile, specifier, exists);
        if (!ruling.ok) {
          unresolved.push({
            script: relScript,
            specifier,
            expectedSource: ruling.sourcePath ? path.relative(root, ruling.sourcePath) : null,
          });
        }
      }
    }
  }

  return { checked, unresolved };
}

// ---------------------------------------------------------------------------
// Computed broker-core path consumers (#2453 PR-0, analyze.md Risks 4).
//
// The literal scan above cannot see a core path that is built at runtime
// (template literal, path.join) or held as data, nor a *source* import of
// `src/core/*.mjs`. Moving a core module would break those silently. This
// inventory names every non-test script that mentions a broker core JS path
// outside a literal compiled-output import specifier, and the check below
//   1. fails when a scanned script gains such a reference that is not listed
//      here (so a new consumer is declared, and found by the next move);
//   2. fails when a listed script no longer contains its reference (stale);
//   3. fails when a listed reference no longer resolves to a core module
//      (dist/core/<x>.js -> src/core/<x>.ts; src/core/<x>.mjs as is), which is
//      exactly what a `git mv` into core/<domain>/ does.
// References are broker-package-relative (`dist/core/...`, `src/core/...`).

const SELF = fileURLToPath(import.meta.url);

/** Directories (non-recursive) scanned for computed core-path consumers. */
export const CORE_PATH_SCAN_DIRS = ['scripts', 'scripts/lib', 'packages/broker/scripts', 'packages/broker/scripts/lib', 'test/conformance', 'test/conformance/lib'];

export const CORE_PATH_CONSUMERS = {
  // DB recovery tool: template literal `${rootDir}/dist/core/store.js` in import().
  'packages/broker/scripts/export-sqlite-state.mjs': ['dist/core/store.js'],
  // join(REPO_ROOT, "dist/core/operator-approval-request.js") in import().
  'packages/broker/scripts/operator-approval-request.mjs': ['dist/core/operator-approval-request.js'],
  // Conformance harness: path.join(root, 'packages/broker/dist/core/...').
  'test/conformance/check-three-component-e2e.mjs': ['dist/core/store.js'],
  'test/conformance/check-trace-propagation.mjs': ['dist/core/broker.js'],
  'test/conformance/lib/ensure-built.mjs': ['dist/core/broker.js', 'dist/core/store.js'],
  // Source imports of the requester-role contract (not compiled output).
  'scripts/a2a-dispatch-round.mjs': ['src/core/requester-role-contract.mjs'],
  'scripts/lib/task-assign-entrypoint.mjs': ['src/core/requester-role-contract.mjs'],
  // Coverage floors keyed by compiled path (data).
  'scripts/check-promotion-capstone-conformance.mjs': ['dist/core/release-evidence.js'],
  'packages/broker/scripts/coverage-baseline-report.mjs': ['dist/core/release-evidence.js', 'dist/core/release-evidence.test.js'],
};

const CORE_PATH_REFERENCE = /(?:packages\/broker\/)?((?:dist|src)\/core\/[\w.-]+(?:\/[\w.-]+)*\.m?js)\b/g;

/** Broker core JS paths a script mentions outside a literal compiled-output import specifier. */
export function extractCorePathReferences(source) {
  const covered = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    if (extractDistSpecifiers(match[0]).length > 0) covered.push([match.index, match.index + match[0].length]);
  }
  const refs = new Set();
  for (const match of source.matchAll(CORE_PATH_REFERENCE)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (/^\s*(?:\/\/|\/\*|\*)/.test(source.slice(lineStart, match.index))) continue; // comment line
    refs.add(match[1]);
  }
  return [...refs].sort();
}

/** Resolve a broker-relative core reference to an existing source module. */
export function corePathReferenceResolves(root, ref, exists = fs.existsSync) {
  const broker = path.join(root, 'packages', 'broker');
  if (exists(path.join(broker, ref))) return true;
  if (ref.startsWith('dist/')) {
    const source = path.join(broker, ref.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
    return exists(source);
  }
  return false;
}

export function checkCorePathConsumers(root, { scanDirs = CORE_PATH_SCAN_DIRS, inventory = CORE_PATH_CONSUMERS, exists = fs.existsSync } = {}) {
  const problems = [];
  const found = new Map();
  for (const dir of scanDirs) {
    for (const file of listScriptFiles(path.join(root, dir))) {
      if (/\.test\.m?js$/.test(file) || file === SELF) continue;
      const refs = extractCorePathReferences(fs.readFileSync(file, 'utf8'));
      if (refs.length) found.set(path.relative(root, file).split(path.sep).join('/'), refs);
    }
  }
  for (const [file, refs] of found) {
    const declared = new Set(inventory[file] ?? []);
    for (const ref of refs) {
      if (!declared.has(ref)) problems.push(`${file} references '${ref}' outside a literal import specifier; add it to CORE_PATH_CONSUMERS so a core move updates it`);
    }
  }
  let checked = 0;
  for (const [file, refs] of Object.entries(inventory)) {
    const present = new Set(found.get(file) ?? []);
    for (const ref of refs) {
      checked += 1;
      if (!present.has(ref)) problems.push(`CORE_PATH_CONSUMERS is stale: ${file} no longer references '${ref}'`);
      else if (!corePathReferenceResolves(root, ref, exists)) problems.push(`${file} references '${ref}', which no longer resolves to a broker core module — update the computed path`);
    }
  }
  return { checked, problems };
}

function main() {
  const { fail, finish } = createDocCheckContext({ name: 'dist import resolution' });
  const root = process.cwd();
  const { checked, unresolved } = collectUnresolved(root);
  console.log(`dist import resolution: ${checked - unresolved.length}/${checked} specifiers resolve`);
  for (const item of unresolved) {
    fail(
      `${item.script} imports '${item.specifier}' but neither the compiled file nor its source ` +
        `(${item.expectedSource ?? 'unmapped'}) exists. ` +
        'Point the specifier at the module\'s current path — `node --check` cannot catch this.',
    );
  }
  const consumers = checkCorePathConsumers(root);
  console.log(`dist import resolution: ${consumers.checked} computed core-path references inventoried, ${consumers.problems.length} problem(s)`);
  for (const problem of consumers.problems) fail(problem);
  finish(`dist import resolution ok: ${checked} specifiers, ${consumers.checked} computed core-path references`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

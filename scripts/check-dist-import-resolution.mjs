#!/usr/bin/env node
/**
 * Resolve every compiled-output import specifier used by operator scripts (#1601).
 *
 * Operator `.mjs` scripts consume broker behaviour through compiled paths such
 * as `../dist/core/mobile-worker-preflight.js`. Nothing verified those paths.
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
  finish(`dist import resolution ok: ${checked} specifiers`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

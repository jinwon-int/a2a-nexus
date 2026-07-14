#!/usr/bin/env node
/**
 * Source quality floor guard (a2a-nexus#1506).
 *
 * The measure-only coverage baseline (packages/-star-/scripts/coverage-baseline-report.mjs)
 * classifies source vs test/generated/archive but never enforces a floor. This
 * gate adds the first *enforced*, deterministic source-quality floor on top of
 * it: the count of unsafe TypeScript suppressions in the source bucket may only
 * ratchet downward.
 *
 * "Unsafe suppression" = a directive that silences a diagnostic without proof it
 * is still needed:
 *   - `@ts-ignore`            (suppresses whatever error, silently rots)
 *   - `@ts-nocheck`           (disables checking for the whole file)
 *   - bare `@ts-expect-error` (no inline explanation of what is expected/why)
 *   - `eslint-disable*`       (dead directive — the repo ships no ESLint config,
 *                              so any such comment suppresses nothing real)
 *
 * `@ts-expect-error` WITH an inline description is the *safe* form (it fails the
 * build when the suppression becomes unnecessary) and is intentionally allowed.
 *
 * Scope is the source bucket only (the src-bundle .ts/.mts/.cts files),
 * excluding test/generated/archive — identical bucket semantics to the coverage
 * baseline classifier. The floor is committed in
 * docs/ops/source-quality-floors.json and only ever ratchets down as
 * suppressions are removed.
 *
 * Safety: read-only counting. No repo import, release, publish, visibility,
 * live dispatch, restart, credential, DB, or Terminal ACK action is performed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocCheckContext } from './lib/doc-check.mjs';

export const FLOOR_MANIFEST_REL = 'docs/ops/source-quality-floors.json';
export const FLOOR_SCHEMA = 'a2a-nexus.source-quality-floor.v1';

const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'coverage', 'dist']);

/**
 * Pure bucket classifier — 'source' | 'test' | 'generated' | 'archive' | 'other'.
 * Kept identical in spirit to the coverage-baseline classifier so the two gates
 * agree on what "source" means.
 */
export function classifyFile(relPath) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/(^|\/)archive\//.test(p)) return 'archive';
  if (/\.test\.(ts|mts|cts|js|mjs|cjs)$/.test(p) || /(^|\/)tests?\//.test(p)) return 'test';
  if (/(^|\/)dist\//.test(p) || /\.tsbuildinfo$/.test(p) || /(^|\/)build-info\.json$/.test(p)) {
    return 'generated';
  }
  if (/(^|\/)src\/.*\.(ts|mts|cts)$/.test(p)) return 'source';
  return 'other';
}

/**
 * Count unsafe suppressions in a single file's text. Pure; separated from the
 * filesystem so it can be unit-tested with synthetic content.
 */
export function countUnsafeSuppressions(text) {
  let count = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    // eslint-disable* is a dead directive here (no ESLint config ships).
    if (/eslint-disable(-next-line|-line)?\b/.test(rawLine)) count += 1;
    if (/@ts-ignore\b/.test(rawLine)) count += 1;
    if (/@ts-nocheck\b/.test(rawLine)) count += 1;
    // Bare @ts-expect-error: the directive with no inline explanation after it.
    const expect = rawLine.match(/@ts-expect-error\b(.*)$/);
    if (expect && expect[1].replace(/[\s:—-]/g, '').length === 0) count += 1;
  }
  return count;
}

function walk(root, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
  return out;
}

/**
 * Walk the tree, keep the source bucket, and total the unsafe suppressions.
 * Returns { measured, files } where files lists any offending source files with
 * their per-file counts (for actionable failure output).
 */
export function collectMeasured(root) {
  const rels = walk(root, root, []);
  let measured = 0;
  const offenders = [];
  for (const rel of rels) {
    if (classifyFile(rel) !== 'source') continue;
    const n = countUnsafeSuppressions(fs.readFileSync(path.join(root, rel), 'utf8'));
    if (n > 0) {
      measured += n;
      offenders.push({ file: rel.replace(/\\/g, '/'), count: n });
    }
  }
  offenders.sort((a, b) => (b.count - a.count) || a.file.localeCompare(b.file));
  return { measured, offenders };
}

/**
 * Pure floor evaluation. Fails closed on a malformed manifest so a corrupted or
 * absent floor can never silently pass the gate.
 */
export function evaluateFloor(measured, manifest) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, failures: ['floor manifest missing or not an object'] };
  }
  if (manifest.$schema !== FLOOR_SCHEMA) {
    failures.push(`floor manifest $schema must be ${FLOOR_SCHEMA}`);
  }
  const floor = manifest.floors && manifest.floors.unsafeSuppressions;
  if (!floor || typeof floor.max !== 'number' || !Number.isInteger(floor.max) || floor.max < 0) {
    failures.push('floors.unsafeSuppressions.max must be a non-negative integer');
    return { ok: false, failures };
  }
  if (measured > floor.max) {
    failures.push(
      `unsafe suppressions in source: ${measured} exceeds floor ${floor.max}. ` +
        'Remove the @ts-ignore/@ts-nocheck/bare @ts-expect-error/eslint-disable ' +
        '(prefer @ts-expect-error WITH an inline explanation), or — only if a new ' +
        'suppression is unavoidable — raise floors.unsafeSuppressions.max in ' +
        `${FLOOR_MANIFEST_REL} with justification (a2a-nexus#1506).`,
    );
  } else if (measured < floor.max) {
    failures.push(
      `unsafe suppressions dropped to ${measured}, below floor ${floor.max}. ` +
        `Ratchet the floor down: set floors.unsafeSuppressions.max to ${measured} ` +
        `in ${FLOOR_MANIFEST_REL} so the surface cannot silently regrow (a2a-nexus#1506).`,
    );
  }
  return { ok: failures.length === 0, failures };
}

function main() {
  const { parseJson, fail, finish } = createDocCheckContext({ name: 'source quality floor guard' });
  const manifest = parseJson(FLOOR_MANIFEST_REL);
  const { measured, offenders } = collectMeasured(process.cwd());
  const floorMax = manifest?.floors?.unsafeSuppressions?.max;
  console.log(
    `source quality floor: unsafe-suppressions=${measured}/${floorMax ?? '?'} ` +
      `(source bucket, test/generated/archive excluded)`,
  );
  const { failures } = evaluateFloor(measured, manifest);
  for (const message of failures) fail(message);
  for (const o of offenders) fail(`  ${o.file}: ${o.count} unsafe suppression(s)`);
  finish('source quality floor ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node
/**
 * Source quality floor guard (a2a-nexus#1506).
 *
 * Package coverage reporters (packages/-star-/scripts/coverage-baseline-report.mjs)
 * classify source vs test/generated/archive and enforce bounded module floors.
 * This separate gate applies repository-wide source-quality ratchets: unsafe
 * TypeScript suppressions may only move downward, and production TypeScript
 * source may not discard a Promise without awaiting, handling, returning,
 * assigning, or explicitly marking reviewed fire-and-forget work with `void`.
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { analyzeProject } from './lib/async-safety.mjs';
import { createDocCheckContext } from './lib/doc-check.mjs';

export const FLOOR_MANIFEST_REL = 'docs/ops/source-quality-floors.json';
export const FLOOR_SCHEMA = 'a2a-nexus.source-quality-floor.v1';
export const ASYNC_SAFETY_PACKAGES = Object.freeze([
  'packages/attestation',
  'packages/broker',
  'packages/docker-runner',
  'packages/policy-referee',
]);

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
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, String(text));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const tokenText = scanner.getTokenText();
    const commentBody = token === ts.SyntaxKind.SingleLineCommentTrivia
      ? tokenText.slice(2)
      : tokenText.slice(2, -2);
    // TypeScript recognizes CR, LF, CRLF, U+2028, and U+2029 as physical line
    // terminators. Scanning comment tokens first avoids false positives in
    // string/template literals that merely contain directive-looking text.
    for (const rawLine of commentBody.split(/\r\n|[\n\r\u2028\u2029]/u)) {
      const line = rawLine.replace(/^\s*\*\s?/, '');
      count += [...line.matchAll(/eslint-disable(?:-next-line|-line)?\b/g)].length;
      count += [...line.matchAll(/@ts-ignore\b/g)].length;
      count += [...line.matchAll(/@ts-nocheck\b/g)].length;
      for (const expect of line.matchAll(/@ts-expect-error\b([^\r\n\u2028\u2029]*)/gu)) {
        if (expect[1].replace(/[\s:—-]/gu, '').length === 0) count += 1;
      }
    }
  }
  return count;
}

export function listTrackedPaths(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    throw new Error(`failed to enumerate tracked files: ${error.message}`);
  }
}

/**
 * Walk the tree, keep the source bucket, and total the unsafe suppressions.
 * Returns { measured, files } where files lists any offending source files with
 * their per-file counts (for actionable failure output).
 */
export function collectMeasured(root) {
  const rels = listTrackedPaths(root);
  const realRoot = fs.realpathSync(root);
  let measured = 0;
  const offenders = [];
  for (const rel of rels) {
    if (classifyFile(rel) !== 'source') continue;
    const sourcePath = path.join(root, rel);
    const realSource = fs.realpathSync(sourcePath);
    const realRelative = path.relative(realRoot, realSource);
    if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`${rel}: tracked source symlink resolves outside the repository`);
    }
    const n = countUnsafeSuppressions(fs.readFileSync(sourcePath, 'utf8'));
    if (n > 0) {
      measured += n;
      offenders.push({ file: rel.replace(/\\/g, '/'), count: n });
    }
  }
  offenders.sort((a, b) => (b.count - a.count) || a.file.localeCompare(b.file));
  return { measured, offenders };
}

export function collectFloatingPromises(root, packageRels = ASYNC_SAFETY_PACKAGES) {
  const findings = [];
  for (const packageRel of packageRels) {
    const packageRoot = path.join(root, packageRel);
    const configPath = path.join(packageRoot, 'tsconfig.json');
    for (const finding of analyzeProject({ configPath, packageRoot })) {
      findings.push({
        ...finding,
        file: `${packageRel}/${finding.file}`,
      });
    }
  }
  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

export function parseAsyncSafetyScope(args) {
  if (args.length === 0) return [...ASYNC_SAFETY_PACKAGES];
  if (
    args.length === 2 &&
    args[0] === '--package' &&
    ASYNC_SAFETY_PACKAGES.includes(args[1])
  ) {
    return [args[1]];
  }
  throw new Error(
    `usage: check-source-quality-floors.mjs [--package <${ASYNC_SAFETY_PACKAGES.join('|')}>]`,
  );
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

export function evaluateFloatingPromiseFloor(measured, manifest) {
  const failures = [];
  const floor = manifest?.floors?.floatingPromises;
  if (!floor || typeof floor.max !== 'number' || !Number.isInteger(floor.max) || floor.max < 0) {
    return {
      ok: false,
      failures: ['floors.floatingPromises.max must be a non-negative integer'],
    };
  }
  if (
    !Array.isArray(floor.packages) ||
    JSON.stringify(floor.packages) !== JSON.stringify(ASYNC_SAFETY_PACKAGES)
  ) {
    failures.push(
      `floors.floatingPromises.packages must equal ${JSON.stringify(ASYNC_SAFETY_PACKAGES)}`,
    );
  }
  if (measured > floor.max) {
    failures.push(
      `floating Promises in production source: ${measured} exceeds floor ${floor.max}. ` +
        'Await, handle, return, or assign each Promise; use explicit void only for ' +
        'reviewed fire-and-forget work (a2a-nexus#1506).',
    );
  } else if (measured < floor.max) {
    failures.push(
      `floating Promises dropped to ${measured}, below floor ${floor.max}. ` +
        `Ratchet floors.floatingPromises.max down to ${measured} in ` +
        `${FLOOR_MANIFEST_REL} (a2a-nexus#1506).`,
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
  for (const o of offenders) console.log(`  ${o.file}: ${o.count} unsafe suppression(s)`);

  let floatingPromises = [];
  let asyncSafetyScope = [];
  try {
    asyncSafetyScope = parseAsyncSafetyScope(process.argv.slice(2));
    floatingPromises = collectFloatingPromises(process.cwd(), asyncSafetyScope);
  } catch (error) {
    fail(
      `floating-Promise analysis failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const floatingFloor = manifest?.floors?.floatingPromises?.max;
  console.log(
    `source quality floor: floating-promises=${floatingPromises.length}/${floatingFloor ?? '?'} ` +
      `(${asyncSafetyScope.join(', ') || 'invalid scope'})`,
  );
  const floatingEvaluation = evaluateFloatingPromiseFloor(
    floatingPromises.length,
    manifest,
  );
  for (const message of floatingEvaluation.failures) fail(message);
  for (const finding of floatingPromises) {
    console.log(
      `  ${finding.file}:${finding.line}:${finding.column} ${finding.expression}`,
    );
  }
  finish('source quality floor ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

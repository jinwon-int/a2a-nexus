#!/usr/bin/env node
/**
 * Coverage baseline report — measure-only quality-floor slice for a2a-nexus#1506.
 *
 * Produces a per-package coverage BASELINE that classifies files into
 * source / test / generated / archive, so a later PR can set an actual floor
 * on source. This is intentionally NOT a floor: it never fails on a threshold
 * and always exits 0 (behavior-neutral, no source edits, no new dependency).
 *
 * The classifier is a pure, unit-tested function (see the sibling .test.mjs).
 * The coverage percentage is best-effort enrichment via Node's built-in
 * `--experimental-test-coverage`; if the local Node/test run cannot produce a
 * parseable number, the report still succeeds with coveragePercent = null.
 *
 * Safety: read-only over the package tree + one local `node --test` run of the
 * already-built dist test suite. No network, no live provider, no secrets.
 */
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..'); // packages/docker-runner

// ── Pure classifier (unit-tested) ───────────────────────────────────────────
// Buckets: 'source' | 'test' | 'generated' | 'archive' | 'other'.
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

export function classifyAll(relPaths) {
  const buckets = { source: [], test: [], generated: [], archive: [], other: [] };
  for (const rel of relPaths) buckets[classifyFile(rel)].push(rel);
  return buckets;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'coverage']);

function walk(dir, base, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

// ── Best-effort source coverage via built-in test coverage ──────────────────
export function parseAllFilesCoverage(reportText) {
  // Node's --experimental-test-coverage prints "# all files | <line%> | ...".
  const m = String(reportText).match(/all files[^\n\d]*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

function measureCoverageBestEffort(distTestFiles) {
  if (!distTestFiles.length) return { coveragePercent: null, note: 'no dist test files found (run build first)' };
  try {
    const res = spawnSync(
      process.execPath,
      ['--test', '--experimental-test-coverage', ...distTestFiles],
      { cwd: pkgRoot, encoding: 'utf8', timeout: 180_000 },
    );
    const text = `${res.stdout || ''}\n${res.stderr || ''}`;
    const pct = parseAllFilesCoverage(text);
    return { coveragePercent: pct, note: pct == null ? 'coverage summary not parseable on this runtime' : 'aggregate over dist test run' };
  } catch (err) {
    return { coveragePercent: null, note: `coverage run skipped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Baseline assembly ───────────────────────────────────────────────────────
export function buildBaseline(relPaths, coverage) {
  const buckets = classifyAll(relPaths);
  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  return {
    schema: 'a2a-nexus.coverage-baseline.v1',
    package: 'docker-runner',
    floor: null, // measure-only: no enforced floor yet (#1506 first slice)
    counts,
    sourceFiles: buckets.source.sort(),
    coverage,
  };
}

function main() {
  const relPaths = walk(pkgRoot, pkgRoot);
  const distTestFiles = relPaths.filter((f) => /^dist\/.*\.test\.js$/.test(f));
  const coverage = measureCoverageBestEffort(distTestFiles);
  const baseline = buildBaseline(relPaths, coverage);

  const c = baseline.counts;
  process.stdout.write(
    `coverage baseline (docker-runner, measure-only):\n` +
      `  source=${c.source} test=${c.test} generated=${c.generated} archive=${c.archive} other=${c.other}\n` +
      `  source coverage: ${coverage.coveragePercent == null ? 'n/a' : `${coverage.coveragePercent}%`} (${coverage.note})\n` +
      `  floor: none (baseline only — a later PR sets the source floor)\n`,
  );

  const outDir = path.join(pkgRoot, 'tmp');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'coverage-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  process.exit(0); // measure-only: never fail on a threshold
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}

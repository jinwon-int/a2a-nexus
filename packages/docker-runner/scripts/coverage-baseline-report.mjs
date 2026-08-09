#!/usr/bin/env node
/**
 * Coverage baseline report + core-module quality floor for a2a-nexus#1506.
 *
 * Classifies files into source / test / generated / archive and enforces
 * conservative line-coverage floors on the runner's lifecycle and evidence
 * modules. Missing measurements and a failed coverage test run fail closed.
 *
 * The classifier is a pure, unit-tested function (see the sibling .test.mjs).
 * Coverage uses Node's built-in `--experimental-test-coverage`; no additional
 * dependency or duplicate test harness is introduced.
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

// Conservative floors leave margin below the Node 22 baseline while making
// regressions in the core lifecycle/evidence/provenance path blocking.
export const CORE_SOURCE_FLOORS = Object.freeze({
  'config.js': 94,
  'execution-proof.js': 95,
  'execution-proof-signing.js': 90,
  'redaction.js': 95,
  'runner.js': 85,
});

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

// ── Enforced source coverage via built-in test coverage ─────────────────────
export function parseAllFilesCoverage(reportText) {
  // Node's --experimental-test-coverage prints "# all files | <line%> | ...".
  const m = String(reportText).match(/all files[^\n\d]*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

export function parseFileLineCoverage(reportText) {
  const measured = {};
  for (const line of String(reportText).split(/\r?\n/)) {
    const match = line.match(
      /^\s*#\s+(.+?\.(?:c|m)?js)\s+\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|/,
    );
    if (match) measured[match[1].trim()] = Number(match[2]);
  }
  return measured;
}

export function evaluateCoverageFloors(
  fileLineCoverage,
  floors = CORE_SOURCE_FLOORS,
) {
  const results = [];
  const failures = [];
  for (const [file, floor] of Object.entries(floors)) {
    const measured = fileLineCoverage?.[file];
    if (!Number.isFinite(measured)) {
      results.push({ file, floor, measured: null, ok: false });
      failures.push(`${file}: coverage missing`);
      continue;
    }
    const ok = measured >= floor;
    results.push({ file, floor, measured, ok });
    if (!ok) failures.push(`${file}: line coverage below floor`);
  }
  return { ok: failures.length === 0, metric: 'line', results, failures };
}

function measureCoverage(distTestFiles) {
  if (!distTestFiles.length) {
    return {
      coveragePercent: null,
      fileLineCoverage: {},
      testExitCode: null,
      note: 'no dist test files found (run build first)',
    };
  }
  try {
    const res = spawnSync(
      process.execPath,
      ['--test', '--experimental-test-coverage', ...distTestFiles],
      { cwd: pkgRoot, encoding: 'utf8', timeout: 180_000 },
    );
    const text = `${res.stdout || ''}\n${res.stderr || ''}`;
    const pct = parseAllFilesCoverage(text);
    return {
      coveragePercent: pct,
      fileLineCoverage: parseFileLineCoverage(text),
      testExitCode: res.status,
      note: res.error
        ? `coverage run failed to spawn: ${res.error.message}`
        : pct == null
          ? 'coverage summary not parseable on this runtime'
          : 'aggregate over dist test run',
    };
  } catch (err) {
    return {
      coveragePercent: null,
      fileLineCoverage: {},
      testExitCode: null,
      note: `coverage run failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Baseline assembly ───────────────────────────────────────────────────────
export function buildBaseline(relPaths, coverage, floors = CORE_SOURCE_FLOORS) {
  const buckets = classifyAll(relPaths);
  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  const floorEvaluation = evaluateCoverageFloors(coverage.fileLineCoverage, floors);
  if (coverage.testExitCode !== 0) {
    floorEvaluation.ok = false;
    floorEvaluation.failures.push(
      `coverage test run failed (exit ${coverage.testExitCode ?? 'unknown'})`,
    );
  }
  return {
    schema: 'a2a-nexus.coverage-baseline.v1',
    package: 'docker-runner',
    floor: { metric: 'line', modules: floors },
    floorEvaluation,
    counts,
    sourceFiles: buckets.source.sort(),
    coverage,
  };
}

function main() {
  const relPaths = walk(pkgRoot, pkgRoot);
  const distTestFiles = relPaths.filter((f) => /^dist\/.*\.test\.js$/.test(f));
  const coverage = measureCoverage(distTestFiles);
  const baseline = buildBaseline(relPaths, coverage);

  const c = baseline.counts;
  process.stdout.write(
    `coverage baseline (docker-runner, enforced core floor):\n` +
      `  source=${c.source} test=${c.test} generated=${c.generated} archive=${c.archive} other=${c.other}\n` +
      `  aggregate coverage: ${coverage.coveragePercent == null ? 'n/a' : `${coverage.coveragePercent}%`} (${coverage.note})\n`,
  );
  for (const result of baseline.floorEvaluation.results) {
    process.stdout.write(
      `  ${result.file}: ${result.measured == null ? 'missing' : `${result.measured}%`} ` +
        `(floor ${result.floor}%) ${result.ok ? 'PASS' : 'FAIL'}\n`,
    );
  }
  process.stdout.write(`  floor: ${baseline.floorEvaluation.ok ? 'PASS' : 'FAIL'}\n`);
  for (const failure of baseline.floorEvaluation.failures) {
    process.stderr.write(`coverage floor: ${failure}\n`);
  }

  const outDir = path.join(pkgRoot, 'tmp');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'coverage-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  process.exitCode = baseline.floorEvaluation.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}

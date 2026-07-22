#!/usr/bin/env node
/**
 * Coverage baseline report + core-module quality floor for a2a-nexus#1506.
 *
 * Classifies files into source / test / generated / archive and enforces
 * conservative line-coverage floors on a tightly bounded recovery, handoff
 * policy, and wake-envelope slice. Missing measurements, malformed coverage
 * output, and a failed coverage test run fail closed.
 *
 * Safety: read-only over the package tree + one local `node --test` run of
 * deterministic source test files against the already-built package. No
 * network, no live provider, and no secrets. Output is written under `tmp/`
 * (gitignored).
 */
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const packageName = path.basename(pkgRoot);

// Exact Node 22 baseline at main 54d1b78c5812df36797dfd64bf8c507d02d8ec8d:
// recovery-guard.js 96.85%, handoff-visibility-policy.js 81.61%, and
// wake-envelope.js 94.95%. These floors leave margin while making regressions
// to the bounded lifecycle, policy, and routing-envelope modules blocking.
export const CORE_SOURCE_FLOORS = Object.freeze({
  'dist/src/handoff-visibility-policy.js': 80,
  'dist/src/recovery-guard.js': 95,
  'dist/src/wake-envelope.js': 93,
});

// The package build excludes test sources. Node 22 executes these checked-in
// TypeScript tests directly while they import the deterministic built modules.
export const COVERAGE_TEST_FILES = Object.freeze([
  'src/handoff-visibility-policy.test.ts',
  'src/recovery-guard.test.ts',
  'src/wake-envelope.test.ts',
]);

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

// Node's text coverage table is hierarchical. Preserve directory labels so a
// same-basename module elsewhere cannot satisfy one of the approved floors.
const PERCENT = '([0-9]+(?:\\.[0-9]+)?)';
const EXACT_PERCENT = new RegExp(`^${PERCENT}$`);

export function parseCoverageReport(reportText) {
  const lines = String(reportText).split(/\r?\n/);
  const failures = [];
  const startIndexes = lines.flatMap((line, index) =>
    /^\s*# start of coverage report\s*$/.test(line) ? [index] : []);
  const endIndexes = lines.flatMap((line, index) =>
    /^\s*# end of coverage report\s*$/.test(line) ? [index] : []);
  if (startIndexes.length !== 1 || endIndexes.length !== 1 || startIndexes[0] >= endIndexes[0]) {
    failures.push('coverage report boundaries missing or ambiguous');
  }

  const table = failures.length === 0
    ? lines.slice(startIndexes[0] + 1, endIndexes[0])
    : [];
  const fileLineCoverage = {};
  let coveragePercent = null;
  let aggregateRows = 0;
  const directoryByIndent = new Map();

  for (const line of table) {
    const comment = line.match(/^\s*#(.*)$/);
    if (!comment) continue;
    const columns = comment[1].split('|');
    const labelColumn = columns[0] ?? '';
    const label = labelColumn.trim();
    if (!label || /^-+$/.test(label) || label.toLowerCase() === 'file') continue;

    const linePercent = (columns[1] ?? '').trim();
    if (label.toLowerCase() === 'all files') {
      aggregateRows += 1;
      const aggregate = linePercent.match(EXACT_PERCENT);
      if (aggregate) coveragePercent = Number(aggregate[1]);
      else failures.push(`malformed coverage aggregate row: ${line.trim()}`);
      continue;
    }

    const indent = labelColumn.length - labelColumn.trimStart().length;
    if (!/\.(?:c|m)?(?:js|ts)$/i.test(label)) {
      if (!linePercent) {
        directoryByIndent.set(indent, label);
        for (const depth of [...directoryByIndent.keys()]) {
          if (depth > indent) directoryByIndent.delete(depth);
        }
      }
      continue;
    }
    const measuredMatch = linePercent.match(EXACT_PERCENT);
    if (!measuredMatch) {
      failures.push(`malformed coverage row: ${line.trim()}`);
      continue;
    }
    const ancestors = [...directoryByIndent.entries()]
      .filter(([depth]) => depth < indent)
      .sort(([left], [right]) => left - right)
      .map(([, directory]) => directory);
    const canonicalPath = [...ancestors, label].join('/');
    const measured = Number(measuredMatch[1]);
    if (Object.hasOwn(fileLineCoverage, canonicalPath)) {
      failures.push(`${canonicalPath}: duplicate coverage row`);
    } else {
      fileLineCoverage[canonicalPath] = measured;
    }
  }
  if (aggregateRows !== 1 || !Number.isFinite(coveragePercent)) {
    failures.push('coverage aggregate row missing or ambiguous');
  }
  for (const [file, measured] of Object.entries(fileLineCoverage)) {
    if (measured < 0 || measured > 100) failures.push(`${file}: invalid line coverage`);
  }
  if (coveragePercent !== null && (coveragePercent < 0 || coveragePercent > 100)) {
    failures.push('coverage aggregate percentage out of range');
  }
  return { ok: failures.length === 0, coveragePercent, fileLineCoverage, failures };
}

export function parseAllFilesCoverage(reportText) {
  const parsed = parseCoverageReport(reportText);
  return parsed.ok ? parsed.coveragePercent : null;
}

export function parseFileLineCoverage(reportText) {
  const parsed = parseCoverageReport(reportText);
  return parsed.ok ? parsed.fileLineCoverage : {};
}

export function evaluateCoverageFloors(fileLineCoverage, floors = CORE_SOURCE_FLOORS) {
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

function measureCoverage() {
  const missing = COVERAGE_TEST_FILES.filter((file) => !existsSync(path.join(pkgRoot, file)));
  if (missing.length) {
    return {
      coveragePercent: null,
      fileLineCoverage: {},
      testExitCode: null,
      reportValid: false,
      reportFailures: [`coverage test files missing: ${missing.join(', ')}`],
      note: 'coverage test files missing',
    };
  }
  try {
    const res = spawnSync(
      process.execPath,
      ['--test', '--experimental-test-coverage', ...COVERAGE_TEST_FILES],
      { cwd: pkgRoot, encoding: 'utf8', timeout: 180_000 },
    );
    const text = `${res.stdout || ''}\n${res.stderr || ''}`;
    const parsed = parseCoverageReport(text);
    return {
      coveragePercent: parsed.coveragePercent,
      fileLineCoverage: parsed.fileLineCoverage,
      testExitCode: res.status,
      reportValid: parsed.ok,
      reportFailures: parsed.failures,
      note: res.error
        ? `coverage run failed to spawn: ${res.error.message}`
        : parsed.ok
          ? 'aggregate over deterministic plugin core tests'
          : 'coverage report malformed',
    };
  } catch (err) {
    return {
      coveragePercent: null,
      fileLineCoverage: {},
      testExitCode: null,
      reportValid: false,
      reportFailures: [err instanceof Error ? err.message : String(err)],
      note: 'coverage run failed',
    };
  }
}

export function buildBaseline(pkg, relPaths, coverage, floors = CORE_SOURCE_FLOORS) {
  const buckets = classifyAll(relPaths);
  const counts = Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]));
  const floorEvaluation = evaluateCoverageFloors(coverage.fileLineCoverage, floors);
  if (coverage.testExitCode !== 0) {
    floorEvaluation.ok = false;
    floorEvaluation.failures.push(`coverage test run failed (exit ${coverage.testExitCode ?? 'unknown'})`);
  }
  if (coverage.reportValid !== true) {
    floorEvaluation.ok = false;
    floorEvaluation.failures.push(
      `coverage report malformed: ${(coverage.reportFailures ?? ['unknown error']).join('; ')}`,
    );
  }
  return {
    schema: 'a2a-nexus.coverage-baseline.v1',
    package: pkg,
    floor: { metric: 'line', modules: floors },
    floorEvaluation,
    counts,
    sourceFiles: buckets.source.sort(),
    coverage,
  };
}

function main() {
  const relPaths = walk(pkgRoot, pkgRoot);
  const coverage = measureCoverage();
  const baseline = buildBaseline(packageName, relPaths, coverage);

  const c = baseline.counts;
  process.stdout.write(
    `coverage baseline (${packageName}, enforced core floor):\n` +
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

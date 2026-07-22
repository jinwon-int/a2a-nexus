#!/usr/bin/env node
/**
 * Coverage baseline report + core-module quality floor for a2a-nexus#1506.
 *
 * Broker parity copy of the docker-runner / openclaw-plugin-a2a baseline. It
 * classifies files into source / test / generated / archive and enforces
 * conservative line-coverage floors on a tightly bounded policy, provenance,
 * and evidence slice. Missing measurements, malformed coverage output, and a
 * failed coverage test run fail closed.
 *
 * The classifier is IDENTICAL to the other two packages (parity/comparability
 * of the `a2a-nexus.coverage-baseline.v1` schema). Broker keeps substantial
 * operational logic in `scripts/*.mjs` (see #1503), which the shared classifier
 * files as `other`, not `source`. Rather than diverge the classifier, this
 * report preserves that sub-count in an additive `notes` field without
 * changing the shared bucket semantics.
 *
 * Safety: read-only over the package tree + one local `node --test` run of the
 * deterministic already-built test files. No network, no live provider, no
 * secrets. Output is written under `tmp/` (gitignored).
 */
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..'); // the package directory (scripts/..)
const packageName = path.basename(pkgRoot);

// Exact Node 22 baseline at main 9ef9b26c8b04b659983dadb01c2777f4f8bd1a59:
// broker-policy.js 85.06%, provenance.js 99.00%, release-evidence.js 98.66%.
// These conservative floors leave margin while making regressions blocking.
export const CORE_SOURCE_FLOORS = Object.freeze({
  'broker-policy.js': 84,
  'provenance.js': 98,
  'release-evidence.js': 97,
});

// Deliberately avoid the broad broker test aggregate: these direct built tests
// are deterministic and exercise exactly the bounded modules above.
export const COVERAGE_TEST_FILES = Object.freeze([
  'dist/core/broker-policy.test.js',
  'dist/core/provenance.test.js',
  'dist/core/release-evidence.test.js',
]);

// ── Pure classifier (unit-tested; IDENTICAL to docker-runner / openclaw) ─────
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

// ── Broker-specific additive note (does NOT change bucket semantics) ─────────
// Non-test `scripts/*.mjs` operational modules currently land in `other`. Surface
// their count so #1503's reverse-ratchet has a data-backed anchor for whether
// to promote them to `source`.
export function countBrokerScriptModules(relPaths) {
  return relPaths.filter(
    (p) => /^scripts\/[^/]+\.mjs$/.test(String(p).replace(/\\/g, '/').replace(/^\.\//, ''))
      && !/\.test\.mjs$/.test(String(p)),
  ).length;
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
const PERCENT = '([0-9]+(?:\\.[0-9]+)?)';

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
  const fileRow = new RegExp(`^\\s*#\\s+(.+?\\.(?:c|m)?js)\\s+\\|\\s*${PERCENT}\\s*\\|`);
  const aggregateRow = new RegExp(`^\\s*#\\s+all files\\s+\\|\\s*${PERCENT}\\s*\\|`, 'i');

  for (const line of table) {
    const aggregate = line.match(aggregateRow);
    if (aggregate) {
      aggregateRows += 1;
      coveragePercent = Number(aggregate[1]);
      continue;
    }
    const file = line.match(fileRow);
    if (file) {
      const name = file[1].trim();
      const measured = Number(file[2]);
      if (Object.hasOwn(fileLineCoverage, name)) failures.push(`${name}: duplicate coverage row`);
      else fileLineCoverage[name] = measured;
      continue;
    }
    if (/^\s*#\s+.+\.(?:c|m)?js\s+\|/.test(line)) {
      failures.push(`malformed coverage row: ${line.trim()}`);
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
      reportFailures: [`built coverage test files missing: ${missing.join(', ')}`],
      note: 'run build before coverage',
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
          ? 'aggregate over deterministic built core tests'
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

// ── Baseline assembly ───────────────────────────────────────────────────────
export function buildBaseline(pkg, relPaths, coverage, floors = CORE_SOURCE_FLOORS) {
  const buckets = classifyAll(relPaths);
  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
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
    notes: {
      // Additive, broker-specific. Non-test scripts/*.mjs currently bucketed as
      // `other`; a future classifier change can decide whether to promote them.
      scriptModulesInOther: countBrokerScriptModules(relPaths),
    },
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
      `  note: ${baseline.notes.scriptModulesInOther} non-test scripts/*.mjs modules are in 'other' (see #1503)\n` +
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

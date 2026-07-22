import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_SOURCE_FLOORS,
  COVERAGE_TEST_FILES,
  classifyFile,
  classifyAll,
  parseCoverageReport,
  parseAllFilesCoverage,
  parseFileLineCoverage,
  evaluateCoverageFloors,
  buildBaseline,
  countBrokerScriptModules,
} from './coverage-baseline-report.mjs';

test('classifyFile separates source from test/generated/archive (broker parity)', () => {
  assert.equal(classifyFile('src/worker.ts'), 'source');
  assert.equal(classifyFile('src/core/adaptive-work-mode-selector.mts'), 'source');
  assert.equal(classifyFile('src/worker.test.ts'), 'test'); // .test wins over src
  assert.equal(classifyFile('scripts/a2a-dispatch-helper.test.mjs'), 'test');
  assert.equal(classifyFile('dist/worker.test.js'), 'test');
  assert.equal(classifyFile('dist/worker.js'), 'generated');
  assert.equal(classifyFile('dist/tsconfig.tsbuildinfo'), 'generated');
  assert.equal(classifyFile('build-info.json'), 'generated');
  assert.equal(classifyFile('archive/old-broker.ts'), 'archive');
  // Broker operational logic in scripts/*.mjs is (intentionally) NOT source under
  // the shared classifier — it lands in 'other'. Surfaced via notes instead.
  assert.equal(classifyFile('scripts/a2a-dispatch-helper.mjs'), 'other');
  assert.equal(classifyFile('README.md'), 'other');
});

test('classifyFile normalizes ./ prefix and backslashes', () => {
  assert.equal(classifyFile('./src/worker.ts'), 'source');
  assert.equal(classifyFile('src\\core\\client.ts'), 'source');
  assert.equal(classifyFile('dist\\a\\b.test.js'), 'test');
});

test('classifyAll buckets a mixed broker file list with counts recoverable', () => {
  const buckets = classifyAll([
    'src/a.ts',
    'src/b.ts',
    'src/a.test.ts',
    'scripts/helper.mjs',
    'dist/a.js',
    'archive/x.ts',
    'README.md',
  ]);
  assert.deepEqual(buckets.source.sort(), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(buckets.test, ['src/a.test.ts']);
  assert.deepEqual(buckets.generated, ['dist/a.js']);
  assert.deepEqual(buckets.archive, ['archive/x.ts']);
  assert.deepEqual(buckets.other.sort(), ['README.md', 'scripts/helper.mjs']);
});

test('countBrokerScriptModules counts only top-level non-test scripts/*.mjs', () => {
  const rel = [
    'scripts/a.mjs',
    'scripts/b.mjs',
    'scripts/a.test.mjs', // test — excluded
    'scripts/lib/nested.mjs', // nested — excluded (top-level only)
    'src/c.ts',
    './scripts/c.mjs', // ./ prefix normalized
    'scripts/d.js', // .js not .mjs — excluded
  ];
  assert.equal(countBrokerScriptModules(rel), 3); // a, b, c
});

const validReport = [
  '# start of coverage report',
  '# file                    | line % | branch % | funcs % | uncovered lines',
  '#  broker-policy.js       |  85.06 |    88.41 |   87.50 | 35-36',
  '#  provenance.js          |  99.00 |    69.23 |  100.00 | 28-29',
  '#  release-evidence.js    |  98.66 |    85.95 |  100.00 | 122-123',
  '# all files               |  89.02 |    82.37 |   93.75 |',
  '# end of coverage report',
].join('\n');

test('coverage contract uses the deterministic built tests and conservative measured floors', () => {
  assert.deepEqual(COVERAGE_TEST_FILES, [
    'dist/core/broker-policy.test.js',
    'dist/core/provenance.test.js',
    'dist/core/release-evidence.test.js',
  ]);
  assert.deepEqual(CORE_SOURCE_FLOORS, {
    'broker-policy.js': 84,
    'provenance.js': 98,
    'release-evidence.js': 97,
  });
});

test('parseCoverageReport extracts the aggregate and per-module line coverage', () => {
  assert.deepEqual(parseCoverageReport(validReport), {
    ok: true,
    coveragePercent: 89.02,
    fileLineCoverage: {
      'broker-policy.js': 85.06,
      'provenance.js': 99,
      'release-evidence.js': 98.66,
    },
    failures: [],
  });
  assert.equal(parseAllFilesCoverage(validReport), 89.02);
  assert.deepEqual(parseFileLineCoverage(validReport), {
    'broker-policy.js': 85.06,
    'provenance.js': 99,
    'release-evidence.js': 98.66,
  });
});

test('parseCoverageReport rejects missing boundaries, malformed rows, and duplicates', () => {
  for (const report of [
    '# all files | 87.5 | 80 | 90 |',
    validReport.replace('85.06', 'not-a-number'),
    validReport.replace(
      '# all files',
      '#  provenance.js          |  99.00 |    69.23 |  100.00 |\n# all files',
    ),
  ]) {
    const parsed = parseCoverageReport(report);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.failures.length > 0);
    assert.equal(parseAllFilesCoverage(report), null);
    assert.deepEqual(parseFileLineCoverage(report), {});
  }
});

test('evaluateCoverageFloors fails closed on a missing or regressed module', () => {
  const measured = {
    'broker-policy.js': 83.99,
    'provenance.js': 99,
  };
  const result = evaluateCoverageFloors(measured);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    'broker-policy.js: line coverage below floor',
    'release-evidence.js: coverage missing',
  ]);
});

test('buildBaseline records and passes the enforced per-module line floor', () => {
  const baseline = buildBaseline('broker', ['src/a.ts', 'scripts/x.mjs', 'src/a.test.ts'], {
    coveragePercent: 89.02,
    fileLineCoverage: {
      'broker-policy.js': 85.06,
      'provenance.js': 99,
      'release-evidence.js': 98.66,
    },
    testExitCode: 0,
    reportValid: true,
    reportFailures: [],
    note: 'aggregate over deterministic built core tests',
  });
  assert.equal(baseline.schema, 'a2a-nexus.coverage-baseline.v1');
  assert.equal(baseline.package, 'broker');
  assert.deepEqual(baseline.floor, { metric: 'line', modules: CORE_SOURCE_FLOORS });
  assert.equal(baseline.floorEvaluation.ok, true);
  assert.equal(baseline.counts.source, 1);
  assert.equal(baseline.counts.test, 1);
  assert.equal(baseline.counts.other, 1);
  assert.deepEqual(baseline.sourceFiles, ['src/a.ts']);
  assert.equal(baseline.notes.scriptModulesInOther, 1);
});

test('buildBaseline fails on a nonzero test process or malformed report', () => {
  const measured = Object.fromEntries(
    Object.entries(CORE_SOURCE_FLOORS).map(([file, floor]) => [file, floor + 1]),
  );
  const failedProcess = buildBaseline('broker', [], {
    coveragePercent: 100,
    fileLineCoverage: measured,
    testExitCode: 1,
    reportValid: true,
    reportFailures: [],
    note: 'test failure',
  });
  assert.equal(failedProcess.floorEvaluation.ok, false);
  assert.deepEqual(failedProcess.floorEvaluation.failures, [
    'coverage test run failed (exit 1)',
  ]);

  const malformed = buildBaseline('broker', [], {
    coveragePercent: null,
    fileLineCoverage: measured,
    testExitCode: 0,
    reportValid: false,
    reportFailures: ['coverage aggregate row missing or ambiguous'],
    note: 'malformed',
  });
  assert.equal(malformed.floorEvaluation.ok, false);
  assert.deepEqual(malformed.floorEvaluation.failures, [
    'coverage report malformed: coverage aggregate row missing or ambiguous',
  ]);
});

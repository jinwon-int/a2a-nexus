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
} from './coverage-baseline-report.mjs';

test('classifyFile separates source from test/generated/archive', () => {
  assert.equal(classifyFile('src/api.ts'), 'source');
  assert.equal(classifyFile('src/core/client.mts'), 'source');
  assert.equal(classifyFile('src/api.test.ts'), 'test');
  assert.equal(classifyFile('type-mapping.test.ts'), 'test');
  assert.equal(classifyFile('test/agent-card-discovery.test.mjs'), 'test');
  assert.equal(classifyFile('dist/api.test.js'), 'test');
  assert.equal(classifyFile('dist/api.js'), 'generated');
  assert.equal(classifyFile('dist/tsconfig.tsbuildinfo'), 'generated');
  assert.equal(classifyFile('archive/old.ts'), 'archive');
  assert.equal(classifyFile('README.md'), 'other');
});

test('classifyFile normalizes ./ prefix and backslashes', () => {
  assert.equal(classifyFile('./src/api.ts'), 'source');
  assert.equal(classifyFile('src\\core\\client.ts'), 'source');
  assert.equal(classifyFile('dist\\a\\b.test.js'), 'test');
});

test('classifyAll buckets a mixed file list with counts recoverable', () => {
  const buckets = classifyAll([
    'src/a.ts',
    'src/b.ts',
    'src/a.test.ts',
    'dist/a.js',
    'archive/x.ts',
    'README.md',
  ]);
  assert.deepEqual(buckets.source.sort(), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(buckets.test, ['src/a.test.ts']);
  assert.deepEqual(buckets.generated, ['dist/a.js']);
  assert.deepEqual(buckets.archive, ['archive/x.ts']);
  assert.deepEqual(buckets.other, ['README.md']);
});

const validReport = [
  '# start of coverage report',
  '# file                                | line % | branch % | funcs % | uncovered lines',
  '# dist                                |        |          |         |',
  '#  src                                |        |          |         |',
  '#   handoff-visibility-policy.js      |  81.61 |    65.85 |   94.12 | 5-6',
  '#   recovery-guard.js                 |  96.85 |    87.14 |   93.75 | 233-235',
  '#   wake-envelope.js                  |  94.95 |    80.77 |   80.00 | 5-7',
  '# src                                 |        |          |         |',
  '#  recovery-guard.test.ts             | 100.00 |   100.00 |  100.00 |',
  '# all files                           |  59.17 |    75.99 |   71.53 |',
  '# end of coverage report',
].join('\n');

test('coverage contract uses deterministic TypeScript tests and conservative measured floors', () => {
  assert.deepEqual(COVERAGE_TEST_FILES, [
    'src/handoff-visibility-policy.test.ts',
    'src/recovery-guard.test.ts',
    'src/wake-envelope.test.ts',
  ]);
  assert.deepEqual(CORE_SOURCE_FLOORS, {
    'dist/src/handoff-visibility-policy.js': 80,
    'dist/src/recovery-guard.js': 95,
    'dist/src/wake-envelope.js': 93,
  });
});

test('parseCoverageReport extracts aggregate and canonical JS/TS paths', () => {
  assert.deepEqual(parseCoverageReport(validReport), {
    ok: true,
    coveragePercent: 59.17,
    fileLineCoverage: {
      'dist/src/handoff-visibility-policy.js': 81.61,
      'dist/src/recovery-guard.js': 96.85,
      'dist/src/wake-envelope.js': 94.95,
      'src/recovery-guard.test.ts': 100,
    },
    failures: [],
  });
  assert.equal(parseAllFilesCoverage(validReport), 59.17);
  assert.deepEqual(parseFileLineCoverage(validReport), {
    'dist/src/handoff-visibility-policy.js': 81.61,
    'dist/src/recovery-guard.js': 96.85,
    'dist/src/wake-envelope.js': 94.95,
    'src/recovery-guard.test.ts': 100,
  });
});

test('parseCoverageReport rejects missing boundaries, malformed rows, and duplicates', () => {
  for (const report of [
    '# all files | 87.5 | 80 | 90 |',
    validReport.replace('81.61', 'not-a-number'),
    validReport.replace(
      '# src                                 |        |          |         |',
      '#   wake-envelope.js                  |  94.95 |    80.77 |   80.00 |\n' +
        '# src                                 |        |          |         |',
    ),
  ]) {
    const parsed = parseCoverageReport(report);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.failures.length > 0);
    assert.equal(parseAllFilesCoverage(report), null);
    assert.deepEqual(parseFileLineCoverage(report), {});
  }
});

test('canonical paths prevent a same-basename module from satisfying a core floor', () => {
  const collisionReport = validReport.replace(
    '#  src                                |        |          |         |',
    '#  other                              |        |          |         |\n' +
      '#   recovery-guard.js               | 100.00 |   100.00 |  100.00 |\n' +
      '#  src                                |        |          |         |',
  );
  const parsed = parseCoverageReport(collisionReport);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fileLineCoverage['dist/other/recovery-guard.js'], 100);
  assert.equal(parsed.fileLineCoverage['dist/src/recovery-guard.js'], 96.85);

  const substitution = parseCoverageReport(
    collisionReport.replace('#   recovery-guard.js                 |  96.85', '#   unrelated.js                      |  96.85'),
  );
  assert.equal(substitution.ok, true);
  assert.deepEqual(evaluateCoverageFloors(substitution.fileLineCoverage).failures, [
    'dist/src/recovery-guard.js: coverage missing',
  ]);
});

test('evaluateCoverageFloors fails closed on a missing or regressed module', () => {
  const measured = {
    'dist/src/handoff-visibility-policy.js': 79.99,
    'dist/src/recovery-guard.js': 96.85,
  };
  const result = evaluateCoverageFloors(measured);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    'dist/src/handoff-visibility-policy.js: line coverage below floor',
    'dist/src/wake-envelope.js: coverage missing',
  ]);
});

test('buildBaseline records and passes the enforced per-module line floor', () => {
  const baseline = buildBaseline(
    'openclaw-plugin-a2a',
    ['src/a.ts', 'src/a.test.ts', 'dist/a.js', 'archive/z.ts'],
    {
      coveragePercent: 59.17,
      fileLineCoverage: {
        'dist/src/handoff-visibility-policy.js': 81.61,
        'dist/src/recovery-guard.js': 96.85,
        'dist/src/wake-envelope.js': 94.95,
      },
      testExitCode: 0,
      reportValid: true,
      reportFailures: [],
      note: 'aggregate over deterministic plugin core tests',
    },
  );
  assert.equal(baseline.schema, 'a2a-nexus.coverage-baseline.v1');
  assert.equal(baseline.package, 'openclaw-plugin-a2a');
  assert.deepEqual(baseline.floor, { metric: 'line', modules: CORE_SOURCE_FLOORS });
  assert.equal(baseline.floorEvaluation.ok, true);
  assert.equal(baseline.counts.source, 1);
  assert.equal(baseline.counts.test, 1);
  assert.equal(baseline.counts.generated, 1);
  assert.equal(baseline.counts.archive, 1);
  assert.deepEqual(baseline.sourceFiles, ['src/a.ts']);
});

test('buildBaseline fails on a nonzero test process or malformed report', () => {
  const measured = Object.fromEntries(
    Object.entries(CORE_SOURCE_FLOORS).map(([file, floor]) => [file, floor + 1]),
  );
  const failedProcess = buildBaseline('openclaw-plugin-a2a', [], {
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

  const malformed = buildBaseline('openclaw-plugin-a2a', [], {
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

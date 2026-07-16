import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_SOURCE_FLOORS,
  classifyFile,
  classifyAll,
  parseAllFilesCoverage,
  parseFileLineCoverage,
  evaluateCoverageFloors,
  buildBaseline,
} from './coverage-baseline-report.mjs';

test('classifyFile separates source from test/generated/archive', () => {
  assert.equal(classifyFile('src/config.ts'), 'source');
  assert.equal(classifyFile('src/core/runner.mts'), 'source');
  assert.equal(classifyFile('src/config.test.ts'), 'test'); // .test wins over src
  assert.equal(classifyFile('dist/config.test.js'), 'test');
  assert.equal(classifyFile('dist/config.js'), 'generated');
  assert.equal(classifyFile('dist/tsconfig.tsbuildinfo'), 'generated');
  assert.equal(classifyFile('src/build-info.json'), 'generated');
  assert.equal(classifyFile('archive/old-runner.ts'), 'archive');
  assert.equal(classifyFile('tests/e2e.ts'), 'test');
  assert.equal(classifyFile('README.md'), 'other');
  assert.equal(classifyFile('scripts/chaos-e2e-gate.mjs'), 'other');
});

test('classifyFile normalizes ./ prefix and backslashes', () => {
  assert.equal(classifyFile('./src/config.ts'), 'source');
  assert.equal(classifyFile('src\\core\\runner.ts'), 'source');
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

test('parseAllFilesCoverage extracts the aggregate line %, else null', () => {
  const report = [
    '# start of coverage report',
    '# file       | line % | branch % | funcs % | uncovered lines',
    '# src/a.js   |  80.00 |  50.00   |  75.00  | 1-2',
    '# all files  |  92.75 |  61.10   |  88.00  | ',
    '# end of coverage report',
  ].join('\n');
  assert.equal(parseAllFilesCoverage(report), 92.75);
  assert.equal(parseAllFilesCoverage('no coverage here'), null);
});

test('parseFileLineCoverage extracts per-module line coverage from the Node table', () => {
  const report = [
    '# file                       | line % | branch % | funcs % | uncovered lines',
    '#  config.js                 |  97.14 |    88.22 |   98.51 | 77-78',
    '#  execution-proof.js        |  98.60 |    86.81 |  100.00 | 117',
    '#  execution-proof.test.js   | 100.00 |   100.00 |  100.00 |',
    '# all files                  |  96.40 |    80.61 |   96.42 |',
  ].join('\n');
  assert.deepEqual(parseFileLineCoverage(report), {
    'config.js': 97.14,
    'execution-proof.js': 98.6,
    'execution-proof.test.js': 100,
  });
});

test('evaluateCoverageFloors passes measurements at or above every core floor', () => {
  const measured = Object.fromEntries(
    Object.entries(CORE_SOURCE_FLOORS).map(([file, floor]) => [file, floor + 0.01]),
  );
  const result = evaluateCoverageFloors(measured);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test('evaluateCoverageFloors fails closed on a missing or regressed core module', () => {
  const measured = Object.fromEntries(
    Object.entries(CORE_SOURCE_FLOORS).map(([file, floor]) => [file, floor + 1]),
  );
  delete measured['runner.js'];
  measured['execution-proof.js'] = CORE_SOURCE_FLOORS['execution-proof.js'] - 0.01;

  const result = evaluateCoverageFloors(measured);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    'execution-proof.js: line coverage below floor',
    'runner.js: coverage missing',
  ]);
});

test('buildBaseline records enforced core floors and classifies source vs the rest', () => {
  const fileLineCoverage = Object.fromEntries(
    Object.entries(CORE_SOURCE_FLOORS).map(([file, floor]) => [file, floor + 1]),
  );
  const baseline = buildBaseline(
    ['src/a.ts', 'src/a.test.ts', 'dist/a.js', 'archive/z.ts'],
    {
      coveragePercent: 92.75,
      fileLineCoverage,
      testExitCode: 0,
      note: 'aggregate over dist test run',
    },
  );
  assert.equal(baseline.schema, 'a2a-nexus.coverage-baseline.v1');
  assert.equal(baseline.package, 'docker-runner');
  assert.deepEqual(baseline.floor, { metric: 'line', modules: CORE_SOURCE_FLOORS });
  assert.equal(baseline.floorEvaluation.ok, true);
  assert.equal(baseline.counts.source, 1);
  assert.equal(baseline.counts.test, 1);
  assert.equal(baseline.counts.generated, 1);
  assert.equal(baseline.counts.archive, 1);
  assert.deepEqual(baseline.sourceFiles, ['src/a.ts']);
  assert.equal(baseline.coverage.coveragePercent, 92.75);
});

test('buildBaseline fails the floor when the underlying coverage test run fails', () => {
  const fileLineCoverage = Object.fromEntries(
    Object.entries(CORE_SOURCE_FLOORS).map(([file, floor]) => [file, floor + 1]),
  );
  const baseline = buildBaseline([], {
    coveragePercent: 99,
    fileLineCoverage,
    testExitCode: 1,
    note: 'coverage test run failed',
  });
  assert.equal(baseline.floorEvaluation.ok, false);
  assert.deepEqual(baseline.floorEvaluation.failures, [
    'coverage test run failed (exit 1)',
  ]);
});

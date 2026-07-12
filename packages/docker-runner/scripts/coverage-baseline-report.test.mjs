import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFile,
  classifyAll,
  parseAllFilesCoverage,
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

test('buildBaseline is measure-only (floor null) and classifies source vs the rest', () => {
  const baseline = buildBaseline(
    ['src/a.ts', 'src/a.test.ts', 'dist/a.js', 'archive/z.ts'],
    { coveragePercent: 92.75, note: 'aggregate over dist test run' },
  );
  assert.equal(baseline.schema, 'a2a-nexus.coverage-baseline.v1');
  assert.equal(baseline.package, 'docker-runner');
  assert.equal(baseline.floor, null, 'first slice is measure-only, no enforced floor');
  assert.equal(baseline.counts.source, 1);
  assert.equal(baseline.counts.test, 1);
  assert.equal(baseline.counts.generated, 1);
  assert.equal(baseline.counts.archive, 1);
  assert.deepEqual(baseline.sourceFiles, ['src/a.ts']);
  assert.equal(baseline.coverage.coveragePercent, 92.75);
});

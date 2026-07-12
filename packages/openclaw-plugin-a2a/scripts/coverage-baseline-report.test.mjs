import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFile,
  classifyAll,
  parseAllFilesCoverage,
  buildBaseline,
} from './coverage-baseline-report.mjs';

test('classifyFile separates source from test/generated/archive', () => {
  assert.equal(classifyFile('src/api.ts'), 'source');
  assert.equal(classifyFile('src/core/client.mts'), 'source');
  assert.equal(classifyFile('src/api.test.ts'), 'test'); // .test wins over src
  assert.equal(classifyFile('type-mapping.test.ts'), 'test');
  assert.equal(classifyFile('test/agent-card-discovery.test.mjs'), 'test');
  assert.equal(classifyFile('dist/api.test.js'), 'test');
  assert.equal(classifyFile('dist/api.js'), 'generated');
  assert.equal(classifyFile('dist/tsconfig.tsbuildinfo'), 'generated');
  assert.equal(classifyFile('archive/old.ts'), 'archive');
  assert.equal(classifyFile('README.md'), 'other');
  assert.equal(classifyFile('scripts/scan-public-readiness.sh'), 'other');
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

test('parseAllFilesCoverage extracts the aggregate line %, else null', () => {
  const report = [
    '# start of coverage report',
    '# all files  |  88.10 |  60.00   |  90.00  | ',
    '# end of coverage report',
  ].join('\n');
  assert.equal(parseAllFilesCoverage(report), 88.1);
  assert.equal(parseAllFilesCoverage('no coverage here'), null);
});

test('buildBaseline is measure-only (floor null) and stamps the given package', () => {
  const baseline = buildBaseline(
    'openclaw-plugin-a2a',
    ['src/a.ts', 'src/a.test.ts', 'dist/a.js', 'archive/z.ts'],
    { coveragePercent: null, note: 'classification only' },
  );
  assert.equal(baseline.schema, 'a2a-nexus.coverage-baseline.v1');
  assert.equal(baseline.package, 'openclaw-plugin-a2a');
  assert.equal(baseline.floor, null, 'measure-only slice: no enforced floor yet');
  assert.equal(baseline.counts.source, 1);
  assert.equal(baseline.counts.test, 1);
  assert.equal(baseline.counts.generated, 1);
  assert.equal(baseline.counts.archive, 1);
  assert.deepEqual(baseline.sourceFiles, ['src/a.ts']);
  assert.equal(baseline.coverage.coveragePercent, null);
});

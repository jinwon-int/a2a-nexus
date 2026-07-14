import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFile,
  classifyAll,
  parseAllFilesCoverage,
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

test('parseAllFilesCoverage extracts the all-files line percent, else null', () => {
  assert.equal(parseAllFilesCoverage('# all files | 87.5 | ...'), 87.5);
  assert.equal(parseAllFilesCoverage('nothing parseable here'), null);
});

test('buildBaseline is measure-only (floor null) with additive broker notes', () => {
  const baseline = buildBaseline('broker', ['src/a.ts', 'scripts/x.mjs', 'src/a.test.ts'], {
    coveragePercent: null,
    note: 'n/a',
  });
  assert.equal(baseline.schema, 'a2a-nexus.coverage-baseline.v1');
  assert.equal(baseline.package, 'broker');
  assert.equal(baseline.floor, null); // never a floor in this slice
  assert.equal(baseline.counts.source, 1);
  assert.equal(baseline.counts.test, 1);
  assert.equal(baseline.counts.other, 1);
  assert.deepEqual(baseline.sourceFiles, ['src/a.ts']);
  assert.equal(baseline.notes.scriptModulesInOther, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { extractDispositionReferences, evaluateDispositionReferences } from './check-disposition-references.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-disposition-references.mjs');

// Shaped after the real #1215 finalizer disposition: a table citing a PR, a
// workflow run link, and backticked repo paths.
const REAL_DISPOSITION_SHAPE = `## Finalizer disposition — 체크리스트 1:1 대조
| 작업 단위 | 처분 | 산출물 |
| --- | --- | --- |
| 구현 | 완료 | PR #1216 (머지) — \`test/conformance/check-three-component-e2e.mjs\` |
| CI 배선 | 완료 | https://github.com/o/r/actions/runs/28569751013 — contracts 잡 |
`;

test('extract: pulls PR numbers, run ids, and repo paths from a real disposition shape', () => {
  const refs = extractDispositionReferences(REAL_DISPOSITION_SHAPE);
  assert.deepEqual(refs.issueOrPrNumbers, [1216]);
  assert.deepEqual(refs.runIds, ['28569751013']);
  assert.deepEqual(refs.paths, ['test/conformance/check-three-component-e2e.mjs']);
});

test('extract: ignores urls and traversal-looking path candidates', () => {
  const refs = extractDispositionReferences('see `https/a.b` no wait `../../etc.passwd` and `a/b.c`');
  assert.deepEqual(refs.paths, ['a/b.c']);
});

const ALL_EXIST = {
  issueOrPrExists: () => true,
  runExists: () => true,
  pathExists: () => true,
};

test('evaluate: all citations existing passes', async () => {
  const refs = extractDispositionReferences(REAL_DISPOSITION_SHAPE);
  const violations = await evaluateDispositionReferences('#1215', refs, ALL_EXIST);
  assert.equal(violations.length, 0);
});

test('evaluate: a cited PR that was never opened is a violation (dead reconciliation)', async () => {
  const refs = extractDispositionReferences('완료 — PR #99999 참조');
  const violations = await evaluateDispositionReferences('#42', refs, { ...ALL_EXIST, issueOrPrExists: () => false });
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /#99999, which does not exist/);
});

test('evaluate: dead run link and missing repo path are violations', async () => {
  const refs = extractDispositionReferences('run https://x/actions/runs/123 and file `no/such-file.mjs`');
  const violations = await evaluateDispositionReferences('#43', refs, {
    ...ALL_EXIST,
    runExists: () => false,
    pathExists: () => false,
  });
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => /workflow run 123/.test(v.reason)));
  assert.ok(violations.some((v) => /no\/such-file\.mjs/.test(v.reason)));
});

test('runs without GITHUB_TOKEN skip cleanly (monitoring gate, not fail-closed)', () => {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped \(no GITHUB_TOKEN/);
});

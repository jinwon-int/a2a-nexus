import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateScorecard } from './check-round-quality-scorecard.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/check-round-quality-scorecard.mjs');

const VALID_ENTRY = {
  id: 'round-x',
  window: { from: '2026-07-01', to: '2026-07-02' },
  scope: 'test scope',
  metrics: { carryOverCount: 1, falseFindingCount: 0, reworkIssueCount: 2 },
  evidence: ['carry-over: a -> b'],
  recordedAt: '2026-07-02',
};

test('valid entry passes', () => {
  assert.deepEqual(evaluateScorecard({ entries: [VALID_ENTRY] }), []);
});

test('missing required metric, negative count, and bad date fail closed', () => {
  const failures = evaluateScorecard({
    entries: [
      { ...VALID_ENTRY, metrics: { carryOverCount: 1, falseFindingCount: 0 } },
      { ...VALID_ENTRY, id: 'round-y', metrics: { ...VALID_ENTRY.metrics, carryOverCount: -1 } },
      { ...VALID_ENTRY, id: 'round-z', recordedAt: 'yesterday' },
    ],
  });
  assert.ok(failures.some((f) => f.includes('metrics.reworkIssueCount is required')));
  assert.ok(failures.some((f) => f.includes('metrics.carryOverCount must be a non-negative integer')));
  assert.ok(failures.some((f) => f.includes('recordedAt must be YYYY-MM-DD')));
});

test('duplicate ids and empty evidence fail closed', () => {
  const failures = evaluateScorecard({ entries: [VALID_ENTRY, { ...VALID_ENTRY }, { ...VALID_ENTRY, id: 'round-y', evidence: [] }] });
  assert.ok(failures.some((f) => f.includes('duplicate id')));
  assert.ok(failures.some((f) => f.includes('evidence must be a non-empty string array')));
});

test('committed baseline scorecard validates and records the 2026-07 track', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(repo, 'docs/ops/round-quality-scorecard.json'), 'utf8'));
  assert.deepEqual(evaluateScorecard(doc), []);
  const baseline = doc.entries.find((entry) => entry.id === 'improvement-track-2026-07');
  assert.ok(baseline, 'baseline entry for the 2026-07 improvement track must exist');
  assert.equal(baseline.metrics.carryOverCount, 2);
  assert.equal(baseline.metrics.falseFindingCount, 2);
});

test('cli fails closed on a malformed scorecard file', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(repo, 'node_modules/.tmp-scorecard-')), 'bad.json');
  fs.writeFileSync(tmp, JSON.stringify({ entries: [{ id: 'bad' }] }));
  const r = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: { ...process.env, ROUND_QUALITY_SCORECARD: tmp },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /round quality scorecard FAILED/);
});

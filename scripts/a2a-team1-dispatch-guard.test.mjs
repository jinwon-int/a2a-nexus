import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateDispatchSpec, validateLaneMetadata, REQUIRED_PARENT_FIELDS } from './a2a-team1-dispatch-guard.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeValidLane(overrides = {}) {
  return {
    worker: 'workerGamma',
    parentRoundId: 'round-test-001',
    parentRoundTotal: 4,
    parentRoundOrder: 1,
    originBrokerId: 'brokerAlpha',
    brokerOfRecordId: 'brokerAlpha',
    ...overrides,
  };
}

function makeValidSpec(overrides = {}, laneOverrides = []) {
  const laneCount = laneOverrides.length || 4;
  return {
    runId: 'a2a-team1-test-round-20260528T000000Z',
    team: 'team1',
    parentRoundId: 'round-test-001',
    parentRoundTotal: laneCount,
    lanes: laneOverrides.length > 0
      ? laneOverrides.map((lo, i) => makeValidLane({ parentRoundOrder: i + 1, ...lo }))
      : Array.from({ length: laneCount }, (_, i) => makeValidLane({ parentRoundOrder: i + 1 })),
    ...overrides,
  };
}

function specFromLane(lane) {
  return makeValidSpec({ parentRoundId: lane.parentRoundId, parentRoundTotal: lane.parentRoundTotal }, [lane]);
}

// ─── Required metadata checks ────────────────────────────────────────────────

test('REQUIRED_PARENT_FIELDS includes all five metadata fields', () => {
  const expected = ['parentRoundId', 'parentRoundTotal', 'parentRoundOrder', 'originBrokerId', 'brokerOfRecordId'];
  assert.deepEqual([...REQUIRED_PARENT_FIELDS].sort(), [...expected].sort());
  assert.equal(REQUIRED_PARENT_FIELDS.length, 5);
});

test('validateDispatchSpec passes with a valid 4-lane spec', () => {
  const spec = makeValidSpec();
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, true);
  assert.equal(result.blockers.length, 0);
});

test('validateDispatchSpec passes with a valid 1-lane spec', () => {
  const spec = makeValidSpec({}, [{}]);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, true);
  assert.equal(result.blockers.length, 0);
});

test('validateDispatchSpec passes when lane has no round context (no parent fields)', () => {
  const spec = {
    runId: 'a2a-team1-simple-dispatch',
    team: 'team1',
    lanes: [{ worker: 'workerGamma' }],
  };
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, true);
  assert.equal(result.blockers.length, 0);
});

// ─── Missing field tests ─────────────────────────────────────────────────────

for (const field of REQUIRED_PARENT_FIELDS) {
  test(`validateDispatchSpec blocks when ${field} is missing on a lane with round context`, () => {
    // Build spec directly to avoid makeValidLane re-adding the default
    const lane = { worker: 'workerGamma', parentRoundId: 'round-test-001', parentRoundTotal: 4, parentRoundOrder: 1, originBrokerId: 'brokerAlpha', brokerOfRecordId: 'brokerAlpha' };
    delete lane[field];
    const spec = { runId: 'test', team: 'team1', lanes: [lane] };
    const result = validateDispatchSpec(spec);
    assert.equal(result.valid, false);
    const hasMissing = result.blockers.some((b) => b.gate.includes(`.${field}`) && b.status === 'MISSING');
    assert.equal(hasMissing, true, `expected blocker for missing ${field}`);
  });
}

for (const field of ['parentRoundId', 'parentRoundTotal']) {
  test(`validateDispatchSpec blocks spec-level ${field} missing on multi-lane dispatch`, () => {
    const spec = makeValidSpec();
    delete spec[field];
    const result = validateDispatchSpec(spec);
    assert.equal(result.valid, false);
    const hasBlocker = result.blockers.some((b) => b.gate === `spec.${field}`);
    assert.equal(hasBlocker, true, `expected blocker for spec-level missing ${field}`);
  });
}

test('validateDispatchSpec blocks runId-only multi-lane dispatch with missing parent metadata', () => {
  const spec = {
    runId: 'a2a-team1-runid-only-multilane',
    team: 'team1',
    lanes: [
      { worker: 'workerGamma' },
      { worker: 'workerBeta' },
      { worker: 'workerAlpha' },
      { worker: 'workerDelta' },
    ],
  };
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.gate === 'spec.parentRoundId'));
  assert.ok(result.blockers.some((b) => b.gate === 'spec.parentRoundTotal'));
  assert.ok(result.blockers.some((b) => b.gate === 'lane[0].parentRoundId'));
  assert.ok(result.blockers.some((b) => b.gate === 'lane[0].parentRoundOrder'));
});

test('validateDispatchSpec blocks when parentRoundOrder exceeds parentRoundTotal', () => {
  const lane = makeValidLane({ parentRoundOrder: 5, parentRoundTotal: 4 });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.reason.includes('exceeds')));
});

// ─── Type validation ─────────────────────────────────────────────────────────

test('validateDispatchSpec blocks empty string parentRoundId', () => {
  const lane = makeValidLane({ parentRoundId: '' });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
});

test('validateDispatchSpec blocks non-integer parentRoundTotal', () => {
  const lane = makeValidLane({ parentRoundTotal: 'abc' });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
});

test('validateDispatchSpec blocks numeric-string parentRoundTotal', () => {
  const lane = makeValidLane({ parentRoundTotal: '4' });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
});

test('validateDispatchSpec blocks numeric-string parentRoundOrder', () => {
  const lane = makeValidLane({ parentRoundOrder: '1' });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
});

test('validateDispatchSpec blocks zero parentRoundTotal', () => {
  const lane = makeValidLane({ parentRoundTotal: 0 });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
});

test('validateDispatchSpec blocks missing worker', () => {
  const spec = { runId: 'test', team: 'team1', lanes: [{ parentRoundId: 'r1', parentRoundTotal: 1, parentRoundOrder: 1, originBrokerId: 'brokerAlpha', brokerOfRecordId: 'brokerAlpha' }] };
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.gate.includes('.worker')));
});

// ─── Retry metadata preservation ─────────────────────────────────────────────

test('validateDispatchSpec allows retry with same metadata', () => {
  const spec = makeValidSpec({
    parentRetryOf: 'retry-batch-001',
    originalRun: {
      lanes: [
        makeValidLane({ parentRoundOrder: 1 }),
        makeValidLane({ parentRoundOrder: 2, worker: 'workerBeta' }),
      ],
    },
  }, [{ parentRetryOf: 'lane-retry', parentRoundOrder: 1 }, { parentRetryOf: 'lane-retry', parentRoundOrder: 2, worker: 'workerBeta' }]);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, true);
  assert.equal(result.blockers.length, 0);
});

test('validateDispatchSpec blocks retry with changed parentRoundId', () => {
  const spec = makeValidSpec({
    parentRetryOf: 'retry-batch-001',
    originalRun: {
      lanes: [makeValidLane({ parentRoundOrder: 1, parentRoundId: 'original-round' })],
    },
  }, [{ parentRetryOf: 'lane-retry', parentRoundOrder: 1, parentRoundId: 'different-round' }]);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.status === 'CONFLICT' && b.gate.includes('parentRoundId')));
});

test('validateDispatchSpec blocks retry with changed originBrokerId', () => {
  const spec = makeValidSpec({
    parentRetryOf: 'retry-batch-001',
    originalRun: { lanes: [makeValidLane({ parentRoundOrder: 1, originBrokerId: 'brokerAlpha' })] },
  }, [{ parentRetryOf: 'lane-retry', parentRoundOrder: 1, originBrokerId: 'brokerBeta' }]);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.status === 'CONFLICT' && b.gate.includes('originBrokerId')));
});

// ─── Dry-run payload ─────────────────────────────────────────────────────────

test('validateDispatchSpec dry-run payload exposes final shape with no secrets', () => {
  const spec = makeValidSpec();
  const result = validateDispatchSpec(spec);
  assert.ok(result.dryRunPayload != null);
  assert.equal(result.dryRunPayload.$schema, 'a2a.team1.dispatch-guard.dry-run.v1');
  assert.equal(result.dryRunPayload.lanesCount, 4);
  assert.equal(result.dryRunPayload.summary.valid, true);

  for (const lp of result.dryRunPayload.lanePayloads) {
    assert.ok(String(lp.parentRoundOrder).match(/^[1-4]$/));
    assert.ok(lp.parentRoundProgress.match(/^[1-4]\/4$/));
    assert.ok(lp.originBrokerId);
    assert.ok(lp.brokerOfRecordId);
    // Verify no secrets leaked
    const json = JSON.stringify(lp);
    assert.doesNotMatch(json, /ghp_|github_pat_|AGENTS\.md|SOUL\.md/);
  }
});

test('validateDispatchSpec dry-run payload shows deterministic progress with 4-lane dispatch', () => {
  const spec = makeValidSpec({ parentRoundTotal: 4, parentRoundId: 'round-4-lane' });
  const result = validateDispatchSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.dryRunPayload != null);
  const progressValues = result.dryRunPayload.lanePayloads.map((lp) => lp.parentRoundProgress);
  assert.deepEqual(progressValues, ['1/4', '2/4', '3/4', '4/4']);
});

test('validateDispatchSpec dry-run payload present even on invalid spec', () => {
  const spec = makeValidSpec();
  delete spec.parentRoundId;
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.dryRunPayload != null, 'dry-run payload should be present even for invalid specs');
});

// ─── Safety pattern detection ────────────────────────────────────────────────

test('validateDispatchSpec blocks spec containing secret tokens', () => {
  const syntheticTokenShape = ['ghp', 'x'.repeat(21)].join('_');
  const lane = makeValidLane({ issueTitle: `auth with ${syntheticTokenShape}` });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.reason.includes('secrets')));
});

test('validateDispatchSpec blocks spec containing runtime bootstrap references', () => {
  const lane = makeValidLane({ focus: 'review AGENTS.md' });
  const spec = specFromLane(lane);
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.reason.includes('runtime-bootstrap-file')));
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test('validateDispatchSpec returns empty dryRunPayload when no round context', () => {
  const spec = { runId: 'simple', team: 'team1', lanes: [{ worker: 'workerGamma' }] };
  const result = validateDispatchSpec(spec);
  assert.equal(result.dryRunPayload, null);
});

test('validateDispatchSpec handles empty lanes gracefully', () => {
  const result = validateDispatchSpec({ runId: 'empty', team: 'team1', lanes: [] });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.gate === 'spec.lanes'));
});

test('validateDispatchSpec handles null spec gracefully', () => {
  const result = validateDispatchSpec(null);
  assert.equal(result.valid, false);
  assert.equal(result.blockers.length, 1);
});

test('validateDispatchSpec handles undefined lanes gracefully', () => {
  const result = validateDispatchSpec({ runId: 'no-lanes' });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.gate === 'spec.lanes'));
});

test('validateDispatchSpec adds warning for non-team1 team', () => {
  const spec = makeValidSpec({ team: 'team2' });
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('team2')));
});

test('validateDispatchSpec missing runId blocks', () => {
  const spec = makeValidSpec();
  delete spec.runId;
  const result = validateDispatchSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((b) => b.gate === 'spec.runId'));
});

// ─── validateLaneMetadata unit tests ─────────────────────────────────────────

test('validateLaneMetadata returns MISSING for null lane', () => {
  const blockers = validateLaneMetadata(null, 0);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, 'MISSING');
});

test('validateLaneMetadata no blockers for lane without round context', () => {
  const blockers = validateLaneMetadata({ worker: 'workerGamma' }, 0);
  assert.equal(blockers.length, 0);
});

test('validateLaneMetadata all five fields required when round context present', () => {
  const blockers = validateLaneMetadata({ parentRoundId: 'r1' }, 0);
  const missingFields = blockers.filter((b) => b.status === 'MISSING');
  // parentRoundId is present, so 4 should be missing
  assert.equal(missingFields.length, 4);
});

// ─── CLI integration via helper pattern ──────────────────────────────────────

test('validateDispatchSpec can be run via CLI-style file input (integration)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-guard-test-'));
  const specPath = join(tmpDir, 'test-spec.json');
  const spec = makeValidSpec();
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  // Validate via exported function (simulating CLI)
  const parsed = JSON.parse(readFileSync(specPath, 'utf8'));
  const result = validateDispatchSpec(parsed);
  assert.equal(result.valid, true);

  // Cleanup
  unlinkSync(specPath);
  rmdirSync(tmpDir);
});

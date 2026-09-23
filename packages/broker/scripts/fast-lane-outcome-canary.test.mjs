import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  collectFastLaneEvidence,
  evaluateFastLaneEvidence,
  runNoLiveCanary,
  runOfflineCanary,
} from './fast-lane-outcome-canary.mjs';

const scriptPath = new URL('./fast-lane-outcome-canary.mjs', import.meta.url).pathname;

function laneAssignment(decision) {
  return {
    version: 'fast-lane.v1',
    mode: 'shadow',
    decision,
    reasonCodes: decision === 'fast' ? ['all_fast_conditions_met'] : ['multi_worker_marker_present'],
  };
}

function sampleSnapshot() {
  return {
    tasks: [
      { id: 'f-ok', status: 'succeeded', laneAssignment: laneAssignment('fast'), claimedAt: '2026-09-20T00:00:00.000Z' },
      { id: 'f-gate-fail', status: 'failed', laneAssignment: laneAssignment('fast') },
      { id: 'g-exec-fail', status: 'failed', laneAssignment: laneAssignment('full'), claimedBy: 'workerdelta' },
      { id: 'g-ok', status: 'succeeded', laneAssignment: laneAssignment('full'), assignedWorkerId: 'workerdelta' },
      { id: 'g-gate-fail', status: 'failed', laneAssignment: laneAssignment('full') },
      { id: 'g-ok-2', status: 'succeeded', laneAssignment: laneAssignment('full'), assignedWorkerId: 'workerdelta' },
    ],
  };
}

describe('fast-lane outcome canary (stage-3 offline evidence)', () => {
  it('renders a no-live proof with explicit criteria and no unsafe actions', () => {
    const report = runNoLiveCanary();

    assert.equal(report.ok, true);
    assert.equal(report.mode, 'no-live');
    assert.equal(report.stage, 'stage-3-offline-evidence');
    assert.equal(report.issue, '#2208');
    assert.equal(report.parent, '#1601');
    assert.equal(report.stateFileRead, false);
    assert.equal(report.brokerHttpRequested, false);
    assert.equal(report.providerCalled, false);
    assert.equal(report.dbMutationAttempted, false);
    assert.equal(report.criteria.minFastSuccessRate, 0.9);
    assert.equal(report.criteria.fastFailureTolerancePp, 2);
    for (const checkName of ['fast-lane accuracy baseline', 'failure-rate non-regression (execution vs gate split)', 're-judgment direction (v1 fast->full)', 'safety gate']) {
      assert.ok(report.checks.find((check) => check.check === checkName), `missing check: ${checkName}`);
    }
    assert.doesNotMatch(JSON.stringify(report), /token|secret|chat_id/);
  });

  it('computes lane outcome math with the execution vs gate failure split', () => {
    const evidence = collectFastLaneEvidence(sampleSnapshot());
    const report = runNoLiveCanary({ snapshot: sampleSnapshot(), minLaneSample: 1, minFastSuccessRate: 0.4 });

    assert.equal(report.ok, true);
    assert.equal(evidence.coverage.malformed, 0);
    const nonRegression = report.checks.find((check) => check.check === 'failure-rate non-regression (execution vs gate split)');
    assert.equal(nonRegression.ok, true);
    assert.equal(nonRegression.fastFailureRate, 0.5);
    assert.equal(nonRegression.fullFailureRate, 0.5);
    assert.equal(nonRegression.fastGateFailures, 1);
    assert.equal(nonRegression.fastExecutionFailures, 0);
    assert.equal(nonRegression.fullGateFailures, 1);
    assert.equal(nonRegression.fullExecutionFailures, 1);
  });

  it('fails the accuracy baseline and non-regression criteria on adverse outcomes', () => {
    const report = runNoLiveCanary({ snapshot: sampleSnapshot(), minLaneSample: 1 });

    const accuracy = report.checks.find((check) => check.check === 'fast-lane accuracy baseline');
    assert.equal(accuracy.ok, false);
    assert.match(accuracy.detail, /50% < 90%/);
    assert.equal(report.ok, false);
  });

  it('blocks re-judgments outside the v1 fast->full scope or disagreeing with the shadow assignment', () => {
    const snapshot = sampleSnapshot();
    snapshot.tasks.push({
      id: 'f-rejudged',
      status: 'succeeded',
      laneAssignment: laneAssignment('fast'),
      laneRejudgment: { at: '2026-09-20T06:00:00.000Z', actorId: 'operator-7', from: 'fast', to: 'full', reasonCode: 'multi_worker_marker_present' },
    });
    const good = evaluateFastLaneEvidence(collectFastLaneEvidence(snapshot), { minLaneSample: 99 });
    assert.ok(good.find((check) => check.check === 're-judgment direction (v1 fast->full)').ok);

    snapshot.tasks.push({
      id: 'f-rewound',
      status: 'succeeded',
      laneAssignment: laneAssignment('fast'),
      laneRejudgment: { at: '2026-09-20T07:00:00.000Z', actorId: 'operator-7', from: 'full', to: 'fast', reasonCode: 'all_fast_conditions_met' },
    });
    const bad = evaluateFastLaneEvidence(collectFastLaneEvidence(snapshot), { minLaneSample: 99 });
    const direction = bad.find((check) => check.check === 're-judgment direction (v1 fast->full)');
    assert.equal(direction.ok, false);
    assert.match(direction.detail, /2 re-judgment invariant violation/);
  });

  it('fails lane record hygiene when the immutable shadow assignment is malformed', () => {
    const snapshot = sampleSnapshot();
    snapshot.tasks.push({ id: 'bad-record', status: 'succeeded', laneAssignment: { ...laneAssignment('fast'), mode: 'enforce' } });
    const checks = evaluateFastLaneEvidence(collectFastLaneEvidence(snapshot), {});
    const hygiene = checks.find((check) => check.check === 'lane record hygiene');
    assert.equal(hygiene.ok, false);
    assert.match(hygiene.detail, /mode is not "shadow"/);
  });

  it('joins outcomes from a STATE_FILE snapshot on disk without mutating anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fast-lane-canary-'));
    try {
      const stateFile = join(dir, 'state.json');
      writeFileSync(stateFile, JSON.stringify(sampleSnapshot()));
      const report = runOfflineCanary({ stateFile, minLaneSample: 1, minFastSuccessRate: 0.4 });
      assert.equal(report.ok, true);
      assert.equal(report.mode, 'offline-state-file');
      assert.equal(report.stateFileRead, true);
      assert.equal(report.laneStats.fast.terminal, 2);
      assert.equal(report.laneStats.full.terminal, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the STATE_FILE cannot be read', () => {
    const report = runOfflineCanary({ stateFile: join(tmpdir(), 'fast-lane-canary-does-not-exist.json') });
    assert.equal(report.ok, false);
    const readCheck = report.checks.find((check) => check.check === 'state file read');
    assert.equal(readCheck.ok, false);
  });

  it('exits 0 with a markdown Done report in no-live mode and 1 on a failed gate', () => {
    const passing = spawnSync(process.execPath, [scriptPath, '--no-live', '--markdown'], { encoding: 'utf8' });
    assert.equal(passing.status, 0);
    assert.match(passing.stdout, /^Done: #2208 fast-lane outcome canary/);
    assert.match(passing.stdout, /PASS fast-lane accuracy baseline/);
    assert.match(passing.stdout, /provider\/live Telegram called: no/);

    const failing = spawnSync(process.execPath, [scriptPath, '--state-file', join(tmpdir(), 'fast-lane-canary-does-not-exist.json')], { encoding: 'utf8' });
    assert.equal(failing.status, 1);
    const report = JSON.parse(failing.stdout);
    assert.equal(report.ok, false);
  });
});

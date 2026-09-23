import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  benchCriteria,
  evaluateBenchMeasurement,
  runMeasurementGate,
  runNoLiveBench,
  validateMeasurementArtifact,
} from './fast-lane-bench-remeasure.mjs';

const scriptPath = new URL('./fast-lane-bench-remeasure.mjs', import.meta.url).pathname;

function validMeasurement() {
  return {
    schemaVersion: 'a2a.fast-lane-bench-measurement.v1',
    measuredAt: '2026-09-21T00:00:00.000Z',
    environment: 'staging',
    cohorts: {
      fast: { terminal: 10, succeeded: 9, failed: 1, canceled: 0, executionFailures: 1, gateFailures: 0, p50E2eMs: 40000 },
      full: { terminal: 10, succeeded: 8, failed: 2, canceled: 0, executionFailures: 1, gateFailures: 1, p50E2eMs: 96000 },
    },
    bench: { solo: { runs: 2, succeeded: 2 }, a2a: { runs: 2, succeeded: 2 } },
  };
}

function writeArtifact(measurement) {
  const dir = mkdtempSync(join(tmpdir(), 'fast-lane-bench-'));
  const file = join(dir, 'measurement.json');
  writeFileSync(file, JSON.stringify(measurement));
  return { dir, file };
}

describe('fast-lane bench re-measure gate (stage-5 offline)', () => {
  it('renders a no-live protocol proof with explicit criteria and no unsafe actions', () => {
    const report = runNoLiveBench();

    assert.equal(report.ok, true);
    assert.equal(report.mode, 'no-live');
    assert.equal(report.stage, 'stage-5-bench-remeasure');
    assert.equal(report.issue, '#2208');
    assert.equal(report.parent, '#1601');
    assert.equal(report.measurementRead, false);
    assert.equal(report.brokerHttpRequested, false);
    assert.equal(report.providerCalled, false);
    assert.equal(report.dbMutationAttempted, false);
    assert.deepEqual(report.criteria, benchCriteria());
    for (const checkName of ['run mode', 'safety gate']) {
      assert.ok(report.checks.find((check) => check.check === checkName), `missing check: ${checkName}`);
    }
    assert.match(report.protocol, /docs\/specs\/fast-lane-default-expansion-gate\.md/);
    assert.match(report.protocol, /--measurement <file>/);
    assert.match(report.protocol, /read-only SQL/);
    assert.match(report.failureReportTemplate, /rejudge-lane/);
    assert.match(report.failureReportTemplate, /fast->full only/);
    assert.doesNotMatch(JSON.stringify(report), /token|secret|chat_id/);
  });

  it('validates measurement artifact hygiene fail-closed', () => {
    assert.match(validateMeasurementArtifact(null), /not a JSON object/);
    assert.match(validateMeasurementArtifact([]), /not a JSON object/);
    assert.match(validateMeasurementArtifact({ ...validMeasurement(), schemaVersion: 'a2a.fast-lane-bench-measurement.v2' }), /schemaVersion must be exactly/);
    assert.match(validateMeasurementArtifact({ ...validMeasurement(), measuredAt: '' }), /measuredAt/);
    assert.match(validateMeasurementArtifact({ ...validMeasurement(), environment: 'production' }), /research\|staging/);
    assert.match(validateMeasurementArtifact({ ...validMeasurement(), cohorts: undefined }), /cohorts is missing/);

    const badTerminal = validMeasurement();
    badTerminal.cohorts.fast.terminal = 11;
    assert.match(validateMeasurementArtifact(badTerminal), /succeeded\+failed\+canceled \(10\) != terminal \(11\)/);

    const badSplit = validMeasurement();
    badSplit.cohorts.full.executionFailures = 2;
    assert.match(validateMeasurementArtifact(badSplit), /executionFailures\+gateFailures \(3\) != failed \(2\)/);

    const badP50 = validMeasurement();
    badP50.cohorts.fast.p50E2eMs = 0;
    assert.match(validateMeasurementArtifact(badP50), /p50E2eMs is missing or not a positive number/);

    const badArm = validMeasurement();
    badArm.bench.a2a.succeeded = 3;
    assert.match(validateMeasurementArtifact(badArm), /succeeded \(3\) > runs \(2\)/);

    assert.equal(validateMeasurementArtifact(validMeasurement()), null);
  });

  it('measurement-gate mode fails closed without a file or with an unreadable or hygiene-violating one', () => {
    const missing = runMeasurementGate({});
    assert.equal(missing.ok, false);
    assert.equal(missing.measurementRead, false);
    assert.match(missing.checks.find((check) => check.check === 'measurement read').detail, /no --measurement file supplied/);

    const unreadable = runMeasurementGate({ measurementFile: join(tmpdir(), 'fast-lane-bench-does-not-exist.json') });
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.checks.find((check) => check.check === 'measurement read').detail, /cannot read measurement artifact/);

    const dir = mkdtempSync(join(tmpdir(), 'fast-lane-bench-'));
    try {
      const hygieneFile = join(dir, 'bad-env.json');
      writeFileSync(hygieneFile, JSON.stringify({ ...validMeasurement(), environment: 'production' }));
      const hygiene = runMeasurementGate({ measurementFile: hygieneFile });
      assert.equal(hygiene.ok, false);
      assert.equal(hygiene.measurementRead, true);
      const hygieneCheck = hygiene.checks.find((check) => check.check === 'measurement hygiene');
      assert.equal(hygieneCheck.ok, false);
      assert.match(hygieneCheck.detail, /research\|staging/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes all gates on a healthy artifact and reports the execution/gate split', () => {
    const { dir, file } = writeArtifact(validMeasurement());
    try {
      const report = runMeasurementGate({ measurementFile: file });
      assert.equal(report.ok, true);
      assert.equal(report.mode, 'measurement-gate');
      assert.equal(report.measurementRead, true);
      assert.equal(report.checks.find((check) => check.check === 'measurement read').ok, true);
      assert.equal(report.checks.find((check) => check.check === 'measurement hygiene').ok, true);
      const p50 = report.checks.find((check) => check.check === 'p50 e2e reduction');
      assert.equal(p50.ok, true);
      assert.equal(p50.fastP50E2eMs, 40000);
      assert.equal(p50.fullP50E2eMs, 96000);
      assert.equal(p50.requiredAtOrBelow, 86400);
      const nonRegression = report.checks.find((check) => check.check === 'failure-rate non-regression (execution vs gate split)');
      assert.equal(nonRegression.ok, true);
      assert.equal(nonRegression.fastFailureRate, 0.1);
      assert.equal(nonRegression.fullFailureRate, 0.2);
      assert.equal(nonRegression.fastExecutionFailures, 1);
      assert.equal(nonRegression.fastGateFailures, 0);
      assert.equal(nonRegression.fullExecutionFailures, 1);
      assert.equal(nonRegression.fullGateFailures, 1);
      const parity = report.checks.find((check) => check.check === 'solo-vs-A2A parity');
      assert.equal(parity.ok, true);
      assert.equal(report.checks.find((check) => check.check === 'safety gate').ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the p50 reduction gate when fast p50 misses the required bound, but accepts equality', () => {
    const slow = validMeasurement();
    slow.cohorts.fast.p50E2eMs = 90000;
    const failing = evaluateBenchMeasurement(slow);
    const p50 = failing.find((check) => check.check === 'p50 e2e reduction');
    assert.equal(p50.ok, false);
    assert.equal(p50.requiredAtOrBelow, 86400);
    assert.match(p50.detail, /not at least 10\.00% below full p50 1\.60m/);

    const boundary = validMeasurement();
    boundary.cohorts.fast.p50E2eMs = 86400;
    assert.equal(evaluateBenchMeasurement(boundary).find((check) => check.check === 'p50 e2e reduction').ok, true);
  });

  it('treats small cohorts and pilot arms as insufficient sample instead of failure', () => {
    const small = validMeasurement();
    small.cohorts = {
      fast: { terminal: 4, succeeded: 4, failed: 0, canceled: 0, executionFailures: 0, gateFailures: 0, p50E2eMs: 30000 },
      full: { terminal: 4, succeeded: 3, failed: 1, canceled: 0, executionFailures: 1, gateFailures: 0, p50E2eMs: 96000 },
    };
    small.bench = { solo: { runs: 1, succeeded: 1 }, a2a: { runs: 1, succeeded: 1 } };
    const checks = evaluateBenchMeasurement(small);
    assert.equal(checks.length, 3);
    for (const check of checks) {
      assert.equal(check.ok, true);
      assert.match(check.detail, /insufficient sample/);
    }
    const parity = checks.find((check) => check.check === 'solo-vs-A2A parity');
    assert.equal(parity.soloRuns, 1);
    assert.equal(parity.a2aRuns, 1);
  });

  it('fails failure-rate non-regression beyond tolerance and honors the pp override', () => {
    const regressed = validMeasurement();
    regressed.cohorts.fast = { terminal: 10, succeeded: 6, failed: 4, canceled: 0, executionFailures: 1, gateFailures: 3, p50E2eMs: 40000 };
    regressed.cohorts.full = { terminal: 10, succeeded: 9, failed: 1, canceled: 0, executionFailures: 1, gateFailures: 0, p50E2eMs: 96000 };
    const failing = evaluateBenchMeasurement(regressed);
    const nonRegression = failing.find((check) => check.check === 'failure-rate non-regression (execution vs gate split)');
    assert.equal(nonRegression.ok, false);
    assert.equal(nonRegression.fastFailureRate, 0.4);
    assert.equal(nonRegression.fullFailureRate, 0.1);
    assert.equal(nonRegression.fastGateFailures, 3);
    assert.match(nonRegression.detail, /exceeds full failure 10\.00% \+ 2pp/);

    const tolerated = evaluateBenchMeasurement(regressed, { fastFailureTolerancePp: 35 });
    assert.equal(tolerated.find((check) => check.check === 'failure-rate non-regression (execution vs gate split)').ok, true);
  });

  it('fails solo-vs-A2A parity when the A2A arm underperforms solo', () => {
    const lopsided = validMeasurement();
    lopsided.bench = { solo: { runs: 3, succeeded: 3 }, a2a: { runs: 3, succeeded: 1 } };
    const failing = evaluateBenchMeasurement(lopsided);
    const parity = failing.find((check) => check.check === 'solo-vs-A2A parity');
    assert.equal(parity.ok, false);
    assert.match(parity.detail, /collaboration parity not met/);

    const insufficient = evaluateBenchMeasurement(lopsided, { minPilotRuns: 5 });
    const waived = insufficient.find((check) => check.check === 'solo-vs-A2A parity');
    assert.equal(waived.ok, true);
    assert.match(waived.detail, /insufficient sample/);
  });

  it('honors threshold overrides in criteria and gate evaluation', () => {
    assert.deepEqual(benchCriteria({ minSample: 5, minP50Reduction: 0.5, fastFailureTolerancePp: 7, minPilotRuns: 4 }), {
      minSample: 5,
      minP50Reduction: 0.5,
      fastFailureTolerancePp: 7,
      minPilotRuns: 4,
      baselineP50E2eMs: { T1: 96000, T2: 46900 },
    });

    const strict = evaluateBenchMeasurement(validMeasurement(), { minP50Reduction: 0.6 });
    const strictP50 = strict.find((check) => check.check === 'p50 e2e reduction');
    assert.equal(strictP50.ok, false);
    assert.equal(strictP50.requiredAtOrBelow, 38400);

    const relaxed = evaluateBenchMeasurement(validMeasurement(), { minP50Reduction: 0.5 });
    assert.equal(relaxed.find((check) => check.check === 'p50 e2e reduction').ok, true);
    assert.equal(relaxed.find((check) => check.check === 'p50 e2e reduction').requiredAtOrBelow, 48000);
  });

  it('exits 0 for no-live and passing artifacts, 1 for failed gates, and 2 on bad args', () => {
    const noLive = spawnSync(process.execPath, [scriptPath, '--no-live', '--json'], { encoding: 'utf8' });
    assert.equal(noLive.status, 0);
    const noLiveReport = JSON.parse(noLive.stdout);
    assert.equal(noLiveReport.ok, true);
    assert.equal(noLiveReport.mode, 'no-live');

    const noLiveMd = spawnSync(process.execPath, [scriptPath, '--no-live', '--markdown'], { encoding: 'utf8' });
    assert.equal(noLiveMd.status, 0);
    assert.match(noLiveMd.stdout, /^Done: #2208 fast-lane bench re-measure/);
    assert.match(noLiveMd.stdout, /PASS run mode/);
    assert.match(noLiveMd.stdout, /provider\/live Telegram called: no/);
    assert.match(noLiveMd.stdout, /# Stage-5 fast-lane bench re-measure protocol/);

    const { dir, file } = writeArtifact(validMeasurement());
    try {
      const passing = spawnSync(process.execPath, [scriptPath, '--measurement', file, '--json'], { encoding: 'utf8' });
      assert.equal(passing.status, 0);
      const passingReport = JSON.parse(passing.stdout);
      assert.equal(passingReport.ok, true);
      assert.equal(passingReport.measurementRead, true);

      const slow = validMeasurement();
      slow.cohorts.fast.p50E2eMs = 90000;
      writeFileSync(file, JSON.stringify(slow));
      const failing = spawnSync(process.execPath, [scriptPath, '--measurement', file, '--markdown'], { encoding: 'utf8' });
      assert.equal(failing.status, 1);
      assert.match(failing.stdout, /^Block: #2208 fast-lane bench re-measure/);
      assert.match(failing.stdout, /FAIL p50 e2e reduction/);

      writeFileSync(file, JSON.stringify({ ...validMeasurement(), environment: 'production' }));
      const hygiene = spawnSync(process.execPath, [scriptPath, '--measurement', file, '--json'], { encoding: 'utf8' });
      assert.equal(hygiene.status, 1);
      const hygieneReport = JSON.parse(hygiene.stdout);
      assert.equal(hygieneReport.ok, false);
      assert.ok(hygieneReport.checks.some((check) => check.check === 'measurement hygiene' && check.ok === false));
      assert.doesNotMatch(hygiene.stdout, /token|secret|chat_id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const badArgs = spawnSync(process.execPath, [scriptPath, '--wat'], { encoding: 'utf8' });
    assert.equal(badArgs.status, 2);
    assert.match(badArgs.stderr, /unknown flag: --wat/);
  });
});

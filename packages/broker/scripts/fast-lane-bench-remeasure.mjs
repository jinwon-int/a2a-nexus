#!/usr/bin/env node
// Fast-lane bench re-measure gate (stage-5, #2208 / parent #1601).
//
// Offline by design. It never performs broker HTTP requests, never deploys or
// restarts anything, never mutates broker/DB state, never sends Telegram, and
// never takes a live measurement itself. Live/pilot measurement stays a
// separately approved operator step (stage-6 gate doc); this script only
// (a) emits the re-measure protocol + failure-report templates in no-live
// mode, or (b) evaluates an operator-supplied offline measurement artifact
// against explicit gates.
//
// Measurement artifact: a2a.fast-lane-bench-measurement.v1 — produced by the
// operator from read-only broker audit SQL (same source as P0-2(b)), with the
// execution vs gate failure split (execution = task shows claim evidence,
// gate = failed without ever being claimed).
//
// Explicit gates (all thresholds overridable):
//   1. measurement hygiene: closed schemaVersion, environment limited to
//      research|staging, cohort arithmetic (terminal = succeeded+failed+
//      canceled; failed = executionFailures+gateFailures), non-negative
//      integers, positive p50. Fail-closed.
//   2. p50 e2e reduction: fast cohort p50 must be at least minP50Reduction
//      (default 0.10) below the full cohort p50 once at least minSample
//      (default 10) terminal fast tasks exist; otherwise "insufficient
//      sample" and the check passes without claiming improvement. Baseline
//      context: analyze p50 T1 1.6m (96000ms) / T2 46.9s (46900ms).
//   3. failure-rate non-regression (execution vs gate split): fast failure
//      rate must not exceed the full failure rate by more than
//      fastFailureTolerancePp points (default 2).
//   4. solo-vs-A2A parity: A2A pilot success rate >= solo success rate once
//      each arm has at least minPilotRuns (default 2) runs; otherwise
//      "insufficient sample".

import { readFileSync } from 'node:fs';
import process from 'node:process';

const MEASUREMENT_SCHEMA = 'a2a.fast-lane-bench-measurement.v1';
const ISSUE = '#2208';
const PARENT_ISSUE = '#1601';
const ALLOWED_ENVIRONMENTS = new Set(['research', 'staging']);
const BASELINE_P50_E2E_MS = { T1: 96000, T2: 46900 }; // analyze p50 T1 1.6m / T2 46.9s
const DEFAULT_MIN_SAMPLE = 10;
const DEFAULT_MIN_P50_REDUCTION = 0.1;
const DEFAULT_FAST_FAILURE_TOLERANCE_PP = 2;
const DEFAULT_MIN_PILOT_RUNS = 2;

function ok(check, detail, extra = undefined) {
  return { check, ok: true, detail, ...extra };
}

function fail(check, detail, extra = undefined) {
  return { check, ok: false, detail, ...extra };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function duration(value) {
  return value >= 60000 ? `${(value / 60000).toFixed(2)}m` : `${(value / 1000).toFixed(1)}s`;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateCohort(name, cohort) {
  if (typeof cohort !== 'object' || cohort === null || Array.isArray(cohort)) return `${name} cohort is not an object`;
  for (const key of ['terminal', 'succeeded', 'failed', 'canceled', 'executionFailures', 'gateFailures']) {
    if (!isPositiveInt(cohort[key])) return `${name}.${key} is missing or not a non-negative integer`;
  }
  if (typeof cohort.p50E2eMs !== 'number' || !Number.isFinite(cohort.p50E2eMs) || cohort.p50E2eMs <= 0) {
    return `${name}.p50E2eMs is missing or not a positive number`;
  }
  if (cohort.succeeded + cohort.failed + cohort.canceled !== cohort.terminal) {
    return `${name}: succeeded+failed+canceled (${cohort.succeeded + cohort.failed + cohort.canceled}) != terminal (${cohort.terminal})`;
  }
  if (cohort.executionFailures + cohort.gateFailures !== cohort.failed) {
    return `${name}: executionFailures+gateFailures (${cohort.executionFailures + cohort.gateFailures}) != failed (${cohort.failed})`;
  }
  return null;
}

function validatePilotArm(name, arm) {
  if (typeof arm !== 'object' || arm === null || Array.isArray(arm)) return `${name} pilot arm is not an object`;
  if (!isPositiveInt(arm.runs)) return `${name}.runs is missing or not a non-negative integer`;
  if (!isPositiveInt(arm.succeeded)) return `${name}.succeeded is missing or not a non-negative integer`;
  if (arm.succeeded > arm.runs) return `${name}: succeeded (${arm.succeeded}) > runs (${arm.runs})`;
  return null;
}

/** Closed-set validation of the offline measurement artifact. Fail-closed. */
export function validateMeasurementArtifact(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'measurement is not a JSON object';
  if (raw.schemaVersion !== MEASUREMENT_SCHEMA) return `schemaVersion must be exactly ${MEASUREMENT_SCHEMA}`;
  if (typeof raw.measuredAt !== 'string' || raw.measuredAt.length === 0) return 'measuredAt is missing or empty';
  if (typeof raw.environment !== 'string' || !ALLOWED_ENVIRONMENTS.has(raw.environment)) {
    return `environment must be one of ${[...ALLOWED_ENVIRONMENTS].join('|')}`;
  }
  if (typeof raw.cohorts !== 'object' || raw.cohorts === null) return 'cohorts is missing';
  for (const lane of ['fast', 'full']) {
    const error = validateCohort(`cohorts.${lane}`, raw.cohorts[lane]);
    if (error) return error;
  }
  if (typeof raw.bench !== 'object' || raw.bench === null) return 'bench is missing';
  for (const arm of ['solo', 'a2a']) {
    const error = validatePilotArm(`bench.${arm}`, raw.bench[arm]);
    if (error) return error;
  }
  return null;
}

function cohortRates(cohort) {
  const terminal = cohort.terminal;
  return {
    terminal,
    p50E2eMs: cohort.p50E2eMs,
    successRate: terminal === 0 ? null : cohort.succeeded / terminal,
    failureRate: terminal === 0 ? null : cohort.failed / terminal,
    executionFailures: cohort.executionFailures,
    gateFailures: cohort.gateFailures,
  };
}

/**
 * Explicit-gate evaluation of a validated measurement artifact. Every check
 * carries its threshold context so the markdown/JSON report can be audited
 * offline. Hygiene must be validated by the caller (validateMeasurementArtifact).
 */
export function evaluateBenchMeasurement(measurement, options = {}) {
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const minP50Reduction = options.minP50Reduction ?? DEFAULT_MIN_P50_REDUCTION;
  const fastFailureTolerancePp = options.fastFailureTolerancePp ?? DEFAULT_FAST_FAILURE_TOLERANCE_PP;
  const minPilotRuns = options.minPilotRuns ?? DEFAULT_MIN_PILOT_RUNS;
  const checks = [];

  const fast = cohortRates(measurement.cohorts.fast);
  const full = cohortRates(measurement.cohorts.full);

  if (fast.terminal >= minSample) {
    const requiredAtOrBelow = full.p50E2eMs * (1 - minP50Reduction);
    checks.push(
      fast.p50E2eMs <= requiredAtOrBelow
        ? ok('p50 e2e reduction', `fast p50 ${duration(fast.p50E2eMs)} <= full p50 ${duration(full.p50E2eMs)} reduced by ${pct(minP50Reduction)} (required <= ${duration(requiredAtOrBelow)}); baseline context analyze p50 T1 ${duration(BASELINE_P50_E2E_MS.T1)} / T2 ${duration(BASELINE_P50_E2E_MS.T2)}`, { fastP50E2eMs: fast.p50E2eMs, fullP50E2eMs: full.p50E2eMs, requiredAtOrBelow })
        : fail('p50 e2e reduction', `fast p50 ${duration(fast.p50E2eMs)} is not at least ${pct(minP50Reduction)} below full p50 ${duration(full.p50E2eMs)} (required <= ${duration(requiredAtOrBelow)}); baseline context analyze p50 T1 ${duration(BASELINE_P50_E2E_MS.T1)} / T2 ${duration(BASELINE_P50_E2E_MS.T2)}`, { fastP50E2eMs: fast.p50E2eMs, fullP50E2eMs: full.p50E2eMs, requiredAtOrBelow }),
    );
  } else {
    checks.push(ok('p50 e2e reduction', `insufficient sample: ${fast.terminal} terminal fast tasks < min-sample ${minSample}; improvement not yet claimable`, { fastTerminal: fast.terminal }));
  }

  if (fast.terminal >= minSample && full.terminal >= minSample) {
    const tolerance = fastFailureTolerancePp / 100;
    checks.push(
      fast.failureRate <= full.failureRate + tolerance
        ? ok('failure-rate non-regression (execution vs gate split)', `fast failure ${pct(fast.failureRate)} <= full failure ${pct(full.failureRate)} + ${fastFailureTolerancePp}pp (split fast ${fast.executionFailures} execution / ${fast.gateFailures} gate, full ${full.executionFailures} execution / ${full.gateFailures} gate)`, { fastFailureRate: fast.failureRate, fullFailureRate: full.failureRate, fastExecutionFailures: fast.executionFailures, fastGateFailures: fast.gateFailures, fullExecutionFailures: full.executionFailures, fullGateFailures: full.gateFailures })
        : fail('failure-rate non-regression (execution vs gate split)', `fast failure ${pct(fast.failureRate)} exceeds full failure ${pct(full.failureRate)} + ${fastFailureTolerancePp}pp (split fast ${fast.executionFailures} execution / ${fast.gateFailures} gate, full ${full.executionFailures} execution / ${full.gateFailures} gate)`, { fastFailureRate: fast.failureRate, fullFailureRate: full.failureRate, fastExecutionFailures: fast.executionFailures, fastGateFailures: fast.gateFailures, fullExecutionFailures: full.executionFailures, fullGateFailures: full.gateFailures }),
    );
  } else {
    checks.push(ok('failure-rate non-regression (execution vs gate split)', `insufficient sample: fast ${fast.terminal} / full ${full.terminal} terminal tasks < min-sample ${minSample}; non-regression not yet claimable`, { fastTerminal: fast.terminal, fullTerminal: full.terminal }));
  }

  const solo = measurement.bench.solo;
  const a2a = measurement.bench.a2a;
  if (solo.runs >= minPilotRuns && a2a.runs >= minPilotRuns) {
    const soloRate = solo.succeeded / solo.runs;
    const a2aRate = a2a.succeeded / a2a.runs;
    checks.push(
      a2aRate >= soloRate
        ? ok('solo-vs-A2A parity', `A2A pilot success ${pct(a2aRate)} (${a2a.succeeded}/${a2a.runs}) >= solo ${pct(soloRate)} (${solo.succeeded}/${solo.runs})`, { soloRuns: solo.runs, soloSucceeded: solo.succeeded, a2aRuns: a2a.runs, a2aSucceeded: a2a.succeeded })
        : fail('solo-vs-A2A parity', `A2A pilot success ${pct(a2aRate)} (${a2a.succeeded}/${a2a.runs}) < solo ${pct(soloRate)} (${solo.succeeded}/${solo.runs}); collaboration parity not met`, { soloRuns: solo.runs, soloSucceeded: solo.succeeded, a2aRuns: a2a.runs, a2aSucceeded: a2a.succeeded }),
    );
  } else {
    checks.push(ok('solo-vs-A2A parity', `insufficient sample: solo ${solo.runs} / A2A ${a2a.runs} pilot runs < min-pilot-runs ${minPilotRuns}; parity not yet claimable`, { soloRuns: solo.runs, a2aRuns: a2a.runs }));
  }

  return checks;
}

export function benchCriteria(options = {}) {
  return {
    minSample: options.minSample ?? DEFAULT_MIN_SAMPLE,
    minP50Reduction: options.minP50Reduction ?? DEFAULT_MIN_P50_REDUCTION,
    fastFailureTolerancePp: options.fastFailureTolerancePp ?? DEFAULT_FAST_FAILURE_TOLERANCE_PP,
    minPilotRuns: options.minPilotRuns ?? DEFAULT_MIN_PILOT_RUNS,
    baselineP50E2eMs: { ...BASELINE_P50_E2E_MS },
  };
}

const PROTOCOL_TEMPLATE = [
  '# Stage-5 fast-lane bench re-measure protocol (#2208 / #1601)',
  '',
  '## Preconditions (each separately approved, see stage-6 gate doc)',
  '',
  '- Rollout step approvals are per-step; this protocol runs only after the',
  '  stage-3 offline outcome canary passes and flag enablement is approved.',
  '- Q1 A2A_FAST_LANE_SKIP_REVIEW_ROUND / Q2 A2A_FAST_LANE_SINGLE_WORKER_FINALIZE',
  '  are enabled only inside the approved research/staging bench environment;',
  '  code defaults stay off everywhere else.',
  '- No live measurement, deploy, or broker/DB mutation is performed by this',
  '  script; it only validates an operator-produced artifact.',
  '',
  '## Cohorts and sample size',
  '',
  '- fast cohort: bench tasks (T1/T2 corpus) whose create-time laneAssignment',
  '  decision is fast (mode "shadow" record present).',
  '- full cohort: same corpus and era with decision full.',
  '- At least min-sample (default 10) terminal tasks per cohort; terminal =',
  '  succeeded/failed/canceled.',
  '',
  '## Measurement source (read-only)',
  '',
  '- Broker audit sqlite, read-only SQL, same source as P0-2(b) latency',
  '  instrumentation; no broker HTTP, no provider calls.',
  '- Failure split: execution failure = task shows claim evidence',
  '  (claimedAt/claimedBy/assignedWorkerId); gate failure = failed without',
  '  ever being claimed.',
  '',
  '## Steps',
  '',
  '1. Run the solo pilot arm, then the A2A pilot arm (same T1/T2 tasks).',
  '2. Export a2a.fast-lane-bench-measurement.v1 JSON: cohorts (terminal/',
  '   succeeded/failed/canceled, execution/gate split, p50 e2e ms) and bench',
  '   arms (runs/succeeded per arm).',
  '3. Evaluate offline:',
  '   node scripts/fast-lane-bench-remeasure.mjs --measurement <file> --json',
  '4. Attach the md+json reports to #2208; no default changes in this step.',
  '5. Expansion decisions follow docs/specs/fast-lane-default-expansion-gate.md',
  '   (each step needs its own approval; evidence-gated).',
  '',
  'Baseline context: analyze p50 T1 1.6m / T2 46.9s (P0).',
].join('\n');

const FAILURE_REPORT_TEMPLATE = [
  '# Fast-lane bench failure report (template)',
  '',
  '- Task: <task id> / lane: fast|full / status: failed|canceled',
  '- Failure class: execution (claim evidence present: <claimedAt/claimedBy/assignedWorkerId>)',
  '  or gate (failed without ever being claimed - broker-side gate suspect)',
  '- Audit refs: <task.created / task.claimed / task.failed / task.lane_assigned ids>',
  '- Acceptance verdict: honest failure kept (no lightweight completion)',
  '- Corrective path: operator lane re-judgment v1 (fast->full only)',
  '  via POST /tasks/:id/rejudge-lane when misclassification is confirmed',
  '- Non-regression verdict: fast failure <x>% vs full <y>% (+ tolerance 2pp)',
  '- Evidence links: <measurement artifact, canary report, gate doc approval>',
].join('\n');

export function runNoLiveBench(options = {}) {
  const checks = [
    ok('run mode', 'no-live template proof; no measurement file read, broker HTTP request, deploy, Telegram send, or broker/DB mutation attempted'),
    ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
  ];
  return {
    kind: 'broker.fast-lane.bench-remeasure',
    mode: 'no-live',
    stage: 'stage-5-bench-remeasure',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    criteria: benchCriteria(options),
    measurementRead: false,
    brokerHttpRequested: false,
    providerCalled: false,
    dbMutationAttempted: false,
    protocol: PROTOCOL_TEMPLATE,
    failureReportTemplate: FAILURE_REPORT_TEMPLATE,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export function runMeasurementGate(options = {}) {
  const base = {
    kind: 'broker.fast-lane.bench-remeasure',
    mode: 'measurement-gate',
    stage: 'stage-5-bench-remeasure',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    criteria: benchCriteria(options),
    measurementFile: options.measurementFile ?? null,
    measurementRead: false,
    brokerHttpRequested: false,
    providerCalled: false,
    dbMutationAttempted: false,
  };
  if (!options.measurementFile) {
    return {
      ...base,
      checks: [
        fail('measurement read', 'no --measurement file supplied; pass an operator-produced a2a.fast-lane-bench-measurement.v1 artifact (or run --no-live for the protocol template)'),
        ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
      ],
      ok: false,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(options.measurementFile, 'utf-8'));
  } catch (error) {
    return {
      ...base,
      checks: [
        fail('measurement read', `cannot read measurement artifact: ${error.message}`),
        ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
      ],
      ok: false,
    };
  }
  const hygieneError = validateMeasurementArtifact(raw);
  if (hygieneError) {
    return {
      ...base,
      measurementRead: true,
      checks: [
        fail('measurement hygiene', hygieneError),
        ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
      ],
      ok: false,
    };
  }
  const checks = [
    ok('measurement read', `parsed ${MEASUREMENT_SCHEMA} artifact (environment ${raw.environment}, measuredAt ${raw.measuredAt})`),
    ok('measurement hygiene', `closed-set schema, environment ${raw.environment} in research|staging, cohort arithmetic and execution/gate split consistent`, { environment: raw.environment }),
    ...evaluateBenchMeasurement(raw, options),
    ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
  ];
  return { ...base, measurementRead: true, cohorts: { fast: cohortRates(raw.cohorts.fast), full: cohortRates(raw.cohorts.full) }, bench: raw.bench, checks, ok: checks.every((check) => check.ok) };
}

export async function runBench(options = {}) {
  return options.noLive ? runNoLiveBench(options) : runMeasurementGate(options);
}

function parseArgs(argv) {
  const options = { noLive: false, markdown: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--no-live':
      case '--dry-run':
        options.noLive = true;
        break;
      case '--markdown':
        options.markdown = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--measurement':
        options.measurementFile = argv[++index];
        if (!options.measurementFile) throw new Error('--measurement requires a file path');
        break;
      case '--min-sample':
        options.minSample = Number(argv[++index]);
        break;
      case '--min-p50-reduction':
        options.minP50Reduction = Number(argv[++index]);
        break;
      case '--fast-failure-tolerance-pp':
        options.fastFailureTolerancePp = Number(argv[++index]);
        break;
      case '--min-pilot-runs':
        options.minPilotRuns = Number(argv[++index]);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return options;
}

function renderMarkdown(report) {
  const title = report.ok ? 'Done' : 'Block';
  const lines = [
    `${title}: ${ISSUE} fast-lane bench re-measure (${report.stage})`,
    '',
    `Parent: ${PARENT_ISSUE}`,
    `Mode: ${report.mode}`,
    `Criteria: min-sample ${report.criteria.minSample}, fast p50 <= full * (1 - ${pct(report.criteria.minP50Reduction)}), fast failure <= full + ${report.criteria.fastFailureTolerancePp}pp, pilot runs >= ${report.criteria.minPilotRuns}`,
    '',
    'Focused validation:',
    ...report.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`),
    '',
    'Safety:',
    `- measurement artifact read: ${report.measurementRead ? 'yes (read-only)' : 'no'}`,
    `- broker HTTP requested: ${report.brokerHttpRequested ? 'yes' : 'no'}`,
    `- provider/live Telegram called: ${report.providerCalled ? 'yes' : 'no'}`,
    `- DB mutation attempted: ${report.dbMutationAttempted ? 'yes' : 'no'}`,
  ];
  if (report.protocol) {
    lines.push('', report.protocol, '', report.failureReportTemplate);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runBench(options);
  if (options.markdown && !options.json) {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fast-lane-bench-remeasure: ${error.message}`);
    process.exit(2);
  });
}

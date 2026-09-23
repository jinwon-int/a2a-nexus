#!/usr/bin/env node
// Fast-lane outcome canary (stage-3 offline evidence, #2208 / parent #1601).
//
// Offline by design: joins the create-time laneAssignment (mode "shadow") and
// laneRejudgment records already persisted on tasks with their task outcomes,
// read from the broker STATE_FILE JSON snapshot. It never performs broker HTTP
// requests, never deploys or restarts anything, never mutates broker/DB state,
// and never sends Telegram. The lane ruling is observational (no lifecycle or
// scheduling change), so lane stats group tasks strictly by the immutable
// create-time assignment decision; re-judgments are reported as a separate
// trend and validated against the v1 invariants (fast->full only, assignment
// record untouched).
//
// Explicit criteria (all thresholds overridable):
//   1. fast-lane accuracy baseline: succeeded share among terminal fast-lane
//      tasks must be >= minFastSuccessRate (default 0.90) once at least
//      minLaneSample terminal fast tasks exist; otherwise the check reports
//      "insufficient sample" and passes without claiming accuracy.
//   2. failure-rate non-regression: fast-lane failure rate must not exceed the
//      full-lane failure rate by more than fastFailureTolerancePp percentage
//      points (default 2). Failures are split into execution failures (task
//      shows claim evidence: claimedAt/claimedBy/assignedWorkerId) and gate
//      failures (failed without ever being claimed), so a broker-side gate
//      problem cannot be mistaken for a worker execution regression.
//   3. re-judgment trend + invariants: every laneRejudgment must be fast->full
//      (v1 scope), must agree with the immutable create-time assignment
//      decision, and the assignment must always stay mode "shadow".

import { readFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_STATE_FILE = '/var/lib/a2a-broker/state.json';
const ISSUE = '#2208';
const PARENT_ISSUE = '#1601';
const LANES = ['fast', 'full'];
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const KNOWN_LANE_REASON_CODES = new Set([
  'all_fast_conditions_met',
  'requester_lane_facts_present',
  'intent_not_analyze',
  'mode_missing',
  'mode_not_read_only_analysis',
  'write_or_implementation_marker_present',
  'worker_assignment_conflict',
  'round_marker_present',
  'fanout_marker_present',
  'multi_worker_marker_present',
  'delegated_workflow_marker_present',
  'worker_mode_missing',
  'worker_not_persistent',
  'policy_decision_missing',
  'policy_decision_unknown',
  'policy_requires_approval',
  'policy_denied',
  'approval_marker_present',
  'sensitive_marker_present',
  'live_marker_present',
  'external_send_marker_present',
  'credential_access_marker_present',
]);
const DEFAULT_MIN_LANE_SAMPLE = 10;
const DEFAULT_MIN_FAST_SUCCESS_RATE = 0.9;
const DEFAULT_FAST_FAILURE_TOLERANCE_PP = 2;

function ok(check, detail, extra = {}) {
  return { ok: true, check, detail, ...extra };
}

function fail(check, detail, extra = {}) {
  return { ok: false, check, detail, ...extra };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function pct(value) {
  return `${round4(value * 100)}%`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const numberOption = (name, fallback) => {
    const raw = readOption(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    stateFile: readOption('--state-file') ?? process.env.STATE_FILE ?? DEFAULT_STATE_FILE,
    noLive: argv.includes('--no-live') || argv.includes('--dry-run'),
    markdown: argv.includes('--markdown') || argv.includes('--format=markdown'),
    json: argv.includes('--json') || argv.includes('--format=json'),
    minLaneSample: numberOption('--min-sample', DEFAULT_MIN_LANE_SAMPLE),
    minFastSuccessRate: numberOption('--min-fast-success-rate', DEFAULT_MIN_FAST_SUCCESS_RATE),
    fastFailureTolerancePp: numberOption('--fast-failure-tolerance-pp', DEFAULT_FAST_FAILURE_TOLERANCE_PP),
  };
}

function validateLaneAssignment(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'laneAssignment is not an object';
  if (raw.version !== 'fast-lane.v1') return 'laneAssignment.version is not fast-lane.v1';
  if (raw.mode !== 'shadow') return 'laneAssignment.mode is not "shadow"';
  if (!LANES.includes(raw.decision)) return 'laneAssignment.decision is not fast|full';
  if (!Array.isArray(raw.reasonCodes) || raw.reasonCodes.length < 1) return 'laneAssignment.reasonCodes is empty';
  if (raw.reasonCodes.some((code) => !KNOWN_LANE_REASON_CODES.has(code))) return 'laneAssignment.reasonCodes has an unknown code';
  return null;
}

function validateLaneRejudgment(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'laneRejudgment is not an object';
  if (!isNonEmptyString(raw.at)) return 'laneRejudgment.at is missing';
  if (!isNonEmptyString(raw.actorId)) return 'laneRejudgment.actorId is missing';
  if (!LANES.includes(raw.from) || !LANES.includes(raw.to)) return 'laneRejudgment.from/to is not fast|full';
  if (!KNOWN_LANE_REJUDGMENT_REASONS.has(raw.reasonCode)) return 'laneRejudgment.reasonCode is unknown';
  if (raw.note !== undefined && typeof raw.note !== 'string') return 'laneRejudgment.note is not a string';
  return null;
}

const KNOWN_LANE_REJUDGMENT_REASONS = KNOWN_LANE_REASON_CODES;

/**
 * Lightweight structural validation of the persisted task records (no zod at
 * serialize time): malformed lane records are counted and skipped instead of
 * failing the whole read, mirroring the per-record isolation of the store
 * snapshot loader.
 */
export function collectFastLaneEvidence(snapshot) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : null;
  if (!tasks) {
    return { error: 'snapshot.tasks is not an array' };
  }
  const valid = [];
  const malformed = [];
  const rejudgments = [];
  let laneAssigned = 0;
  for (const task of tasks) {
    if (typeof task !== 'object' || task === null || !isNonEmptyString(task.id) || !isNonEmptyString(task.status)) {
      malformed.push({ taskId: null, error: 'task is missing id or status' });
      continue;
    }
    let assignment = null;
    if (task.laneAssignment !== undefined) {
      const assignmentError = validateLaneAssignment(task.laneAssignment);
      if (assignmentError) {
        malformed.push({ taskId: task.id, error: assignmentError });
        continue;
      }
      assignment = task.laneAssignment;
    }
    let rejudgment = null;
    if (task.laneRejudgment !== undefined) {
      const rejudgmentError = validateLaneRejudgment(task.laneRejudgment);
      if (rejudgmentError) {
        malformed.push({ taskId: task.id, error: rejudgmentError });
        continue;
      }
      rejudgment = task.laneRejudgment;
      rejudgments.push({ taskId: task.id, ...task.laneRejudgment });
    }
    if (assignment) laneAssigned += 1;
    valid.push({
      id: task.id,
      status: task.status,
      decision: assignment?.decision ?? null,
      hasClaimEvidence: Boolean(task.claimedAt || task.claimedBy || task.assignedWorkerId),
      assignmentMode: assignment?.mode ?? null,
      rejudgment,
    });
  }
  return {
    tasks: valid,
    malformed,
    rejudgments,
    coverage: {
      tasks: tasks.length,
      laneAssigned,
      unclassified: valid.length - laneAssigned,
      malformed: malformed.length,
    },
  };
}

function emptyLaneStats() {
  return {
    total: 0,
    terminal: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    inFlight: 0,
    executionFailures: 0,
    gateFailures: 0,
    successRate: null,
    failureRate: null,
  };
}

export function summarizeLaneOutcomes(tasks) {
  const stats = { fast: emptyLaneStats(), full: emptyLaneStats() };
  for (const task of tasks) {
    if (!task.decision) continue;
    const lane = stats[task.decision];
    lane.total += 1;
    if (!TERMINAL_STATUSES.has(task.status)) {
      lane.inFlight += 1;
      continue;
    }
    lane.terminal += 1;
    if (task.status === 'succeeded') lane.succeeded += 1;
    if (task.status === 'canceled') lane.canceled += 1;
    if (task.status === 'failed') {
      lane.failed += 1;
      if (task.hasClaimEvidence) lane.executionFailures += 1;
      else lane.gateFailures += 1;
    }
  }
  for (const lane of LANES) {
    if (stats[lane].terminal > 0) {
      stats[lane].successRate = round4(stats[lane].succeeded / stats[lane].terminal);
      stats[lane].failureRate = round4(stats[lane].failed / stats[lane].terminal);
    }
  }
  return stats;
}

export function summarizeRejudgments(rejudgments, tasks) {
  const byDirection = {};
  const taskIds = new Set();
  let latestAt = null;
  const violations = [];
  const decisionsById = new Map(tasks.map((task) => [task.id, task.decision]));
  const assignmentModesById = new Map(tasks.map((task) => [task.id, task.assignmentMode]));
  for (const entry of rejudgments) {
    taskIds.add(entry.taskId);
    const direction = `${entry.from}->${entry.to}`;
    byDirection[direction] = (byDirection[direction] ?? 0) + 1;
    if (latestAt === null || entry.at > latestAt) latestAt = entry.at;
    if (entry.from !== 'fast' || entry.to !== 'full') {
      violations.push({ taskId: entry.taskId, error: `direction ${direction} is outside v1 scope (fast->full only)` });
    }
    if (decisionsById.get(entry.taskId) !== entry.from) {
      violations.push({ taskId: entry.taskId, error: `re-judgment from=${entry.from} disagrees with create-time assignment decision=${decisionsById.get(entry.taskId)}` });
    }
    if (assignmentModesById.get(entry.taskId) !== 'shadow') {
      violations.push({ taskId: entry.taskId, error: 'create-time laneAssignment is not mode "shadow"' });
    }
  }
  return {
    total: rejudgments.length,
    distinctTasks: taskIds.size,
    byDirection,
    latestAt,
    violations,
  };
}

/**
 * Explicit-criteria evaluation over collected evidence. Every check carries
 * its threshold context so the markdown/JSON report can be audited offline.
 */
export function evaluateFastLaneEvidence(evidence, options = {}) {
  const minLaneSample = options.minLaneSample ?? DEFAULT_MIN_LANE_SAMPLE;
  const minFastSuccessRate = options.minFastSuccessRate ?? DEFAULT_MIN_FAST_SUCCESS_RATE;
  const fastFailureTolerancePp = options.fastFailureTolerancePp ?? DEFAULT_FAST_FAILURE_TOLERANCE_PP;
  const checks = [];

  if (evidence.error) {
    checks.push(fail('state snapshot parse', evidence.error));
    return checks;
  }

  const laneStats = summarizeLaneOutcomes(evidence.tasks);
  const rejudgment = summarizeRejudgments(evidence.rejudgments, evidence.tasks);

  checks.push(
    evidence.malformed.length === 0
      ? ok('lane record hygiene', `all ${evidence.coverage.laneAssigned} lane-assigned tasks carry well-formed fast-lane.v1 shadow records (${evidence.coverage.unclassified} tasks unclassified)`, { coverage: evidence.coverage })
      : fail('lane record hygiene', `${evidence.malformed.length} malformed lane record(s), first: task ${evidence.malformed[0].taskId ?? '(no id)'}: ${evidence.malformed[0].error}`, { coverage: evidence.coverage, malformed: evidence.malformed.slice(0, 5) }),
  );

  const fast = laneStats.fast;
  if (fast.terminal >= minLaneSample) {
    checks.push(
      fast.successRate >= minFastSuccessRate
        ? ok('fast-lane accuracy baseline', `fast-lane shadow success ${pct(fast.successRate)} >= ${pct(minFastSuccessRate)} over ${fast.terminal} terminal tasks`, { fastTerminal: fast.terminal, fastSuccessRate: fast.successRate })
        : fail('fast-lane accuracy baseline', `fast-lane shadow success ${pct(fast.successRate)} < ${pct(minFastSuccessRate)} over ${fast.terminal} terminal tasks`, { fastTerminal: fast.terminal, fastSuccessRate: fast.successRate }),
    );
  } else {
    checks.push(ok('fast-lane accuracy baseline', `insufficient sample: ${fast.terminal} terminal fast tasks < min-sample ${minLaneSample}; accuracy not yet claimable`, { fastTerminal: fast.terminal }));
  }

  const full = laneStats.full;
  if (fast.terminal >= minLaneSample && full.terminal >= minLaneSample) {
    const tolerance = fastFailureTolerancePp / 100;
    const regression = fast.failureRate - full.failureRate;
    checks.push(
      regression <= tolerance
        ? ok('failure-rate non-regression (execution vs gate split)', `fast failure ${pct(fast.failureRate)} <= full failure ${pct(full.failureRate)} + ${fastFailureTolerancePp}pp (split fast ${fast.executionFailures} execution / ${fast.gateFailures} gate, full ${full.executionFailures} execution / ${full.gateFailures} gate)`, {
          fastFailureRate: fast.failureRate,
          fullFailureRate: full.failureRate,
          fastExecutionFailures: fast.executionFailures,
          fastGateFailures: fast.gateFailures,
          fullExecutionFailures: full.executionFailures,
          fullGateFailures: full.gateFailures,
        })
        : fail('failure-rate non-regression (execution vs gate split)', `fast failure ${pct(fast.failureRate)} exceeds full failure ${pct(full.failureRate)} + ${fastFailureTolerancePp}pp (split fast ${fast.executionFailures} execution / ${fast.gateFailures} gate, full ${full.executionFailures} execution / ${full.gateFailures} gate)`, {
          fastFailureRate: fast.failureRate,
          fullFailureRate: full.failureRate,
          fastExecutionFailures: fast.executionFailures,
          fastGateFailures: fast.gateFailures,
          fullExecutionFailures: full.executionFailures,
          fullGateFailures: full.gateFailures,
        }),
    );
  } else {
    checks.push(ok('failure-rate non-regression (execution vs gate split)', `insufficient sample: fast ${fast.terminal} / full ${full.terminal} terminal tasks < min-sample ${minLaneSample}; non-regression not yet claimable`, { fastTerminal: fast.terminal, fullTerminal: full.terminal }));
  }

  checks.push(
    rejudgment.violations.length === 0
      ? ok('re-judgment direction (v1 fast->full)', rejudgment.total === 0
        ? 'no lane re-judgments recorded yet (direction invariant vacuously holds)'
        : `all ${rejudgment.total} re-judgment(s) are fast->full and agree with the immutable shadow assignment`, { rejudgment })
      : fail('re-judgment direction (v1 fast->full)', `${rejudgment.violations.length} re-judgment invariant violation(s), first: task ${rejudgment.violations[0].taskId}: ${rejudgment.violations[0].error}`, { rejudgment }),
  );

  checks.push(ok('re-judgment trend', `${rejudgment.total} re-judgment(s) across ${rejudgment.distinctTasks} task(s)${rejudgment.latestAt ? `, latest at ${rejudgment.latestAt}` : ''}`, { rejudgment }));
  return checks;
}

function sampleNoLiveSnapshot() {
  const task = (id, status, decision, extra = {}) => ({
    id,
    status,
    ...(decision
      ? {
        laneAssignment: {
          version: 'fast-lane.v1',
          mode: 'shadow',
          decision,
          reasonCodes: decision === 'fast' ? ['all_fast_conditions_met'] : ['multi_worker_marker_present'],
        },
      }
      : {}),
    ...extra,
  });
  const tasks = [];
  for (let index = 1; index <= 9; index += 1) {
    tasks.push(task(`fast-ok-${index}`, 'succeeded', 'fast', { claimedAt: '2026-09-20T01:00:00.000Z', claimedBy: 'workeralpha' }));
  }
  tasks.push(task('fast-exec-fail', 'failed', 'fast', { claimedAt: '2026-09-20T02:00:00.000Z', claimedBy: 'workeralpha' }));
  for (let index = 1; index <= 7; index += 1) {
    tasks.push(task(`full-ok-${index}`, 'succeeded', 'full', { claimedAt: '2026-09-20T03:00:00.000Z', claimedBy: 'workerdelta' }));
  }
  tasks.push(task('full-exec-fail', 'failed', 'full', { claimedAt: '2026-09-20T04:00:00.000Z', claimedBy: 'workerdelta' }));
  tasks.push(task('full-exec-fail-2', 'failed', 'full', { claimedAt: '2026-09-20T05:00:00.000Z', claimedBy: 'workerdelta' }));
  tasks.push(task('full-gate-fail', 'failed', 'full'));
  tasks.push(task('fast-rejudged', 'succeeded', 'fast', {
    claimedAt: '2026-09-20T06:00:00.000Z',
    claimedBy: 'workeralpha',
    laneRejudgment: { at: '2026-09-20T06:30:00.000Z', actorId: 'operator-7', from: 'fast', to: 'full', reasonCode: 'multi_worker_marker_present' },
  }));
  tasks.push(task('unclassified-in-flight', 'queued', null));
  return { schemaVersion: 'a2a.broker.snapshot.v1', tasks };
}

export function runNoLiveCanary(options = {}) {
  const snapshot = options.snapshot ?? sampleNoLiveSnapshot();
  const evidence = collectFastLaneEvidence(snapshot);
  const checks = [
    ok('run mode', 'no-live synthetic proof; no STATE_FILE read, broker HTTP request, deploy, Gateway restart, Telegram send, or broker/DB mutation attempted'),
    ...evaluateFastLaneEvidence(evidence, options),
    ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
  ];
  const laneStats = evidence.error ? null : summarizeLaneOutcomes(evidence.tasks);
  return {
    kind: 'broker.fast-lane.outcome-canary',
    mode: 'no-live',
    stage: 'stage-3-offline-evidence',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    criteria: {
      minLaneSample: options.minLaneSample ?? DEFAULT_MIN_LANE_SAMPLE,
      minFastSuccessRate: options.minFastSuccessRate ?? DEFAULT_MIN_FAST_SUCCESS_RATE,
      fastFailureTolerancePp: options.fastFailureTolerancePp ?? DEFAULT_FAST_FAILURE_TOLERANCE_PP,
    },
    stateFileRead: false,
    brokerHttpRequested: false,
    providerCalled: false,
    dbMutationAttempted: false,
    coverage: evidence.error ? null : evidence.coverage,
    laneStats,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export function runOfflineCanary(options = {}) {
  const stateFile = options.stateFile ?? process.env.STATE_FILE ?? DEFAULT_STATE_FILE;
  const base = {
    kind: 'broker.fast-lane.outcome-canary',
    mode: 'offline-state-file',
    stage: 'stage-3-offline-evidence',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    criteria: {
      minLaneSample: options.minLaneSample ?? DEFAULT_MIN_LANE_SAMPLE,
      minFastSuccessRate: options.minFastSuccessRate ?? DEFAULT_MIN_FAST_SUCCESS_RATE,
      fastFailureTolerancePp: options.fastFailureTolerancePp ?? DEFAULT_FAST_FAILURE_TOLERANCE_PP,
    },
    stateFileRead: false,
    brokerHttpRequested: false,
    providerCalled: false,
    dbMutationAttempted: false,
  };
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch (error) {
    const checks = [
      fail('state file read', `cannot read broker STATE_FILE: ${error.message}`),
      ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
    ];
    return { ...base, stateFile, checks, ok: false };
  }
  const evidence = collectFastLaneEvidence(snapshot);
  const checks = [
    ok('state file read', `parsed broker STATE_FILE snapshot (${evidence.error ? 'no tasks array' : `${evidence.coverage.tasks} tasks`})`),
    ...evaluateFastLaneEvidence(evidence, options),
    ok('safety gate', 'read-only offline validation only; no broker HTTP call, provider call, or state mutation'),
  ];
  return {
    ...base,
    stateFile,
    stateFileRead: true,
    coverage: evidence.error ? null : evidence.coverage,
    laneStats: evidence.error ? null : summarizeLaneOutcomes(evidence.tasks),
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export async function runCanary(options = {}) {
  return options.noLive ? runNoLiveCanary(options) : runOfflineCanary(options);
}

function renderMarkdown(report) {
  const title = report.ok ? 'Done' : 'Block';
  const lines = [
    `${title}: ${ISSUE} fast-lane outcome canary (${report.stage})`,
    '',
    `Parent: ${PARENT_ISSUE}`,
    `Mode: ${report.mode}`,
    `Criteria: min-sample ${report.criteria.minLaneSample}, fast success >= ${pct(report.criteria.minFastSuccessRate)}, fast failure <= full + ${report.criteria.fastFailureTolerancePp}pp`,
    '',
    'Focused validation:',
    ...report.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`),
    '',
    'Safety:',
    `- STATE_FILE read: ${report.stateFileRead ? 'yes (read-only)' : 'no'}`,
    `- broker HTTP requested: ${report.brokerHttpRequested ? 'yes' : 'no'}`,
    `- provider/live Telegram called: ${report.providerCalled ? 'yes' : 'no'}`,
    `- DB mutation attempted: ${report.dbMutationAttempted ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCanary(options);
  if (options.markdown && !options.json) {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fast-lane-outcome-canary: ${error.message}`);
    process.exit(2);
  });
}

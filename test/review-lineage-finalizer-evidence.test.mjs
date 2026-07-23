import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeVerdict } from '../scripts/a2ad-finalizer-gate.mjs';
import {
  evaluateReviewLineageFinalizerEvidence,
  validateReviewLineageFinalizerEvidence,
} from '../scripts/lib/review-lineage-finalizer-evidence.mjs';

const ROUND = 'a2a-nexus-issue1518-phase6-test';
const ORIGINAL_HEAD = '1'.repeat(40);
const CURRENT_HEAD = '2'.repeat(40);
const BASE_HEAD = '0'.repeat(40);
const INTENT_HASH = `sha256:${'3'.repeat(64)}`;
const DIFF_HASH = `sha256:${'4'.repeat(64)}`;
const SCRIPT_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'scripts',
  'a2ad-finalizer-gate.mjs',
);

function finding(overrides = {}) {
  return {
    findingId: 'F-1',
    criterionRef: 'AC-1',
    evidenceRefs: ['scripts/a2ad-finalizer-gate.mjs:1'],
    severity: 'major',
    category: 'correctness',
    blocking: true,
    introducedAtHead: ORIGINAL_HEAD,
    firstSeenAtHead: ORIGINAL_HEAD,
    resolvedAtHead: CURRENT_HEAD,
    disposition: 'resolved',
    signature: `sha256:${'5'.repeat(64)}`,
    ...overrides,
  };
}

function lineageRecord(overrides = {}) {
  const state = overrides.state ?? 'passed';
  const terminalReason = Object.hasOwn(overrides, 'terminalReason')
    ? overrides.terminalReason
    : null;
  return {
    kind: 'a2a.review-lineage.v1',
    lineageId: 'pr-lineage-a2a-nexus-1518-phase6',
    mode: 'enforce',
    state,
    contract: {
      kind: 'IntentContractV1',
      lineageId: 'pr-lineage-a2a-nexus-1518-phase6',
      goal: 'Consume bounded review-lineage evidence additively.',
      nonGoals: ['Change signed verdict verification.'],
      invariants: ['Existing quorum failures remain blocking.'],
      acceptanceCriteria: [{ id: 'AC-1', text: 'Lineage evidence is fail-closed.' }],
      declaredPaths: {
        allowed: ['scripts/**', 'docs/specs/bounded-pr-review-lifecycle/**'],
        forbidden: ['packages/broker/src/server.ts'],
      },
      baseSha: BASE_HEAD,
      headSha: ORIGINAL_HEAD,
      createdAt: '2026-07-23T11:00:00.000Z',
      intentHash: INTENT_HASH,
    },
    budget: {
      kind: 'ReviewLineageBudgetV1',
      maxWallClockSeconds: 21600,
      maxCorrectionGenerations: 1,
      maxReviewerRuns: 2,
      maxReviewerReplacements: 1,
      repeatedFindingThreshold: 2,
      onExhaustion: 'blocked_needs_operator',
    },
    ledger: {
      kind: 'FindingLedgerV1',
      ledgerId: 'ledger-a2a-nexus-1518-phase6',
      lineageId: 'pr-lineage-a2a-nexus-1518-phase6',
      findings: [finding()],
    },
    appeal: {
      kind: 'AppealDispositionStateV1',
      lineageId: 'pr-lineage-a2a-nexus-1518-phase6',
      finalizerOwnerId: null,
      requests: [],
      dispositions: [],
    },
    counters: {
      correctionGenerations: 1,
      reviewerRuns: 2,
      reviewerReplacements: 0,
      findingsNew: 1,
      findingsReopened: 0,
      findingsResolved: 1,
      repeatedSignatureHits: 0,
      goalpostRejections: 0,
      scopeDriftRejections: 0,
    },
    currentHeadSha: CURRENT_HEAD,
    currentDiffHash: DIFF_HASH,
    startedAt: '2026-07-23T11:00:00.000Z',
    updatedAt: '2026-07-23T11:30:00.000Z',
    terminalReason,
    unresolvedSignatures: {},
    ...overrides,
  };
}

function envelope(record = lineageRecord(), overrides = {}) {
  return {
    kind: 'a2a.finalizer-lineage-evidence.v1',
    parentRoundId: ROUND,
    record,
    ...overrides,
  };
}

function task(id = 'task-phase6-pass') {
  return {
    id,
    status: 'succeeded',
    assignedWorkerId: 'worker-reviewer',
    payload: {
      parentRoundId: ROUND,
      parentRoundTotal: 1,
      parentRoundOrder: 1,
    },
  };
}

function verdictOptions(extra = {}) {
  return {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Independent evidence: task-phase6-pass.',
    ...extra,
  };
}

function runCli(lineageContent) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'a2ad-lineage-gate-'));
  const tasksPath = join(dir, 'tasks.json');
  const draftPath = join(dir, 'draft.md');
  const lineagePath = join(dir, 'lineage.json');
  fs.writeFileSync(tasksPath, JSON.stringify({ items: [task()] }));
  fs.writeFileSync(draftPath, 'Independent evidence: task-phase6-pass.\n');
  fs.writeFileSync(
    lineagePath,
    typeof lineageContent === 'string' ? lineageContent : JSON.stringify(lineageContent),
  );
  return spawnSync(process.execPath, [
    SCRIPT_PATH,
    '--tasks',
    tasksPath,
    '--round',
    ROUND,
    '--draft',
    draftPath,
    '--lineage',
    lineagePath,
    '--json',
  ], { encoding: 'utf8' });
}

test('Phase 6 envelope validates the full durable lineage record', () => {
  const parsed = validateReviewLineageFinalizerEvidence(envelope());
  assert.equal(parsed.record.lineageId, 'pr-lineage-a2a-nexus-1518-phase6');
  assert.equal(parsed.record.ledger.findings.length, 1);
});

test('Phase 6 envelope rejects unknown envelope keys and incomplete records', () => {
  assert.throws(
    () => validateReviewLineageFinalizerEvidence(envelope(lineageRecord(), { runtimeEnforce: true })),
    /unexpected field/i,
  );
  const { counters: _counters, ...incomplete } = lineageRecord();
  assert.throws(
    () => validateReviewLineageFinalizerEvidence(envelope(incomplete)),
    /record\.counters/i,
  );
});

test('lineage input remains optional and leaves the legacy result shape unchanged', () => {
  const result = computeVerdict([task()], verdictOptions());
  assert.equal(result.verdict, 'FINAL');
  assert.equal(Object.hasOwn(result, 'lineageEvidence'), false);
});

test('valid off/record evidence is observational and cannot change a legacy FINAL', () => {
  for (const mode of ['off', 'record']) {
    const record = lineageRecord({
      mode,
      state: 'reviewing_initial',
      currentHeadSha: ORIGINAL_HEAD,
      currentDiffHash: null,
    });
    const result = computeVerdict(
      [task()],
      verdictOptions({ lineageEvidence: envelope(record) }),
    );
    assert.equal(result.verdict, 'FINAL', mode);
    assert.equal(result.lineageEvidence.outcome, 'not_enforced', mode);
    assert.equal(result.lineageEvidence.blocksFinality, false, mode);
  }
});

test('enforce/passed evidence composes with the existing FINAL decision', () => {
  const result = computeVerdict(
    [task()],
    verdictOptions({ lineageEvidence: envelope() }),
  );
  assert.equal(result.verdict, 'FINAL');
  assert.equal(result.lineageEvidence.outcome, 'completion_allowed');
  assert.equal(result.lineageEvidence.reasonCode, 'lineage_passed');
});

test('lineage evidence never erases an existing quorum failure', () => {
  const result = computeVerdict(
    [],
    verdictOptions({ lineageEvidence: envelope() }),
  );
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.reasons.some((reason) => /quorum/i.test(reason)));
});

test('active enforce states fail closed as review_pending', () => {
  for (const state of ['reviewing_initial', 'correction_pending', 'reviewing_resolution']) {
    const result = computeVerdict(
      [task()],
      verdictOptions({
        lineageEvidence: envelope(lineageRecord({
          state,
          currentHeadSha: ORIGINAL_HEAD,
          currentDiffHash: null,
        })),
      }),
    );
    assert.equal(result.verdict, 'BLOCKED', state);
    assert.equal(result.lineageEvidence.outcome, 'review_pending', state);
    assert.equal(result.lineageEvidence.reasonCode, 'lineage_active', state);
  }
});

test('terminal block states remain terminal and visible', () => {
  const cases = [
    ['blocked_needs_operator', 'budget_reviewer_runs', 'blocked_needs_operator'],
    ['intent_conflict', 'intent_drift', 'intent_conflict'],
    ['canceled', 'operator_cancel', 'canceled'],
  ];
  for (const [state, terminalReason, outcome] of cases) {
    const result = computeVerdict(
      [task()],
      verdictOptions({
        lineageEvidence: envelope(lineageRecord({ state, terminalReason })),
      }),
    );
    assert.equal(result.verdict, 'BLOCKED', state);
    assert.equal(result.lineageEvidence.outcome, outcome, state);
    assert.equal(result.lineageEvidence.blocksFinality, true, state);
  }
});

test('state/reason mismatch and round mismatch fail closed', () => {
  const badState = evaluateReviewLineageFinalizerEvidence(
    envelope(lineageRecord({
      state: 'passed',
      terminalReason: 'budget_wall_clock',
    })),
    ROUND,
  );
  assert.equal(badState.outcome, 'invalid_state');
  assert.equal(badState.reasonCode, 'lineage_state_reason_mismatch');
  assert.equal(badState.blocksFinality, true);

  const badRound = evaluateReviewLineageFinalizerEvidence(
    envelope(),
    'another-round',
  );
  assert.equal(badRound.outcome, 'invalid_state');
  assert.equal(badRound.reasonCode, 'lineage_round_mismatch');
  assert.equal(badRound.blocksFinality, true);
});

test('passed lineages with open blockers or incomplete exact-subject data fail closed', () => {
  const openFinding = lineageRecord({
    ledger: {
      ...lineageRecord().ledger,
      findings: [finding({
        disposition: 'open',
        resolvedAtHead: null,
      })],
    },
    unresolvedSignatures: {
      [`sha256:${'5'.repeat(64)}`]: 1,
    },
  });
  const openResult = evaluateReviewLineageFinalizerEvidence(envelope(openFinding), ROUND);
  assert.equal(openResult.reasonCode, 'lineage_open_blocking_findings');
  assert.equal(openResult.blocksFinality, true);

  const incompleteSubject = evaluateReviewLineageFinalizerEvidence(
    envelope(lineageRecord({ currentDiffHash: null })),
    ROUND,
  );
  assert.equal(incompleteSubject.reasonCode, 'lineage_subject_incomplete');
  assert.equal(incompleteSubject.blocksFinality, true);
});

test('CLI --lineage emits the additive evaluation and preserves FINAL for enforce/passed', () => {
  const run = runCli(envelope());
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.verdict, 'FINAL');
  assert.equal(output.lineageEvidence.outcome, 'completion_allowed');
  assert.equal(output.lineageEvidence.reasonCode, 'lineage_passed');
});

test('CLI --lineage exits 1 for an active enforce lineage', () => {
  const run = runCli(envelope(lineageRecord({
    state: 'reviewing_resolution',
    currentDiffHash: null,
  })));
  assert.equal(run.status, 1, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.verdict, 'BLOCKED');
  assert.equal(output.lineageEvidence.reasonCode, 'lineage_active');
});

test('CLI --lineage rejects malformed JSON with exit 2', () => {
  const run = runCli('{not-json');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /invalid lineage evidence JSON/i);
});

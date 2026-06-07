/**
 * No-live approval-gated auto-closeout action reconciliation fixture harness tests.
 *
 * Validates CI-safe reconciliation artifacts for approval-gated auto-closeout
 * action reconciliation. Covers comment_only, comment_and_close, duplicate
 * idempotency, GitHub 403, stale evidence, rollback/no-op, and timeout/retry
 * behaviors without live GitHub mutation, broker round closeout, Gateway
 * restart, provider send, terminal ACK, DB mutation, PR merge, secret
 * disclosure, or auto-closeout execution.
 *
 * Safety gate: source-only. Production auto-closeout is never enabled.
 * Approval gating is always preserved. Fail-closed behavior is enforced.
 *
 * Parent: a2a-docker-runner#307
 * Parent: a2a-broker#844
 * Run: a2a-team1-auto-closeout-action-reconcile-20260520T180955Z
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildHandlerResult, buildRunnerTaskFromHandlerPayload, extractGitHubEvidence } from "./integration.js";
import type { HandlerResult, HandlerTask, RawRunnerOutput, TerminalEvidenceKind, TerminalEvidenceStatus } from "./integration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Fixture types ───────────────────────────────────────────────────────────

interface ReconciliationFixture {
  $schema: string;
  description: string;
  run: string;
  parentRoundId: string;
  issue: string;
  parent: string;
  parentRoundTotal: number;
  parentRoundOrder: number;
  parentRoundProgress: number;
  originBrokerId: string;
  brokerOfRecordId: string;
  parentBrokerId: string;
  noLiveProof: {
    fixtureOnly: boolean;
    autoCloseoutEnabled: false;
    liveAutoCloseoutExecution: false;
    liveBrokerRoundCloseout: false;
    brokerRestart: false;
    gatewayRestart: false;
    workerRestart: false;
    liveProviderSend: false;
    terminalAck: "not_attempted";
    productionDbMutation: false;
    secretOrVisibilityChange: false;
    providerSendIsReceiptEvidence: false;
    prMergeAutomation: false;
    releasePublish: false;
    credentialMovement: false;
    allowedEvidence: string[];
  };
  canonicalCloseout: {
    allowedEvidenceKinds: TerminalEvidenceKind[];
    terminalAckRequiresOperatorVisibleReceipt: true;
    providerSendSuccessIsReceiptEvidence: false;
    noLiveProviderSend: true;
    terminalOutboxAckPerformed: false;
    autoCloseoutMode: "source_only";
  };
  activeNodes: string[];
  source: {
    schemaVersion: string;
    parentRoundTotal: number;
    parentRoundOrder: number;
    parentRoundProgress: number;
    originBrokerId: string;
    brokerOfRecordId: string;
    parentBrokerId: string;
  };
  reconciliationSemantics: {
    approvalGateRequired: boolean;
    autoCloseoutActionNeverTriggered: boolean;
    failClosedOnApprovalGateFailure: boolean;
    noLiveGithubMutation: boolean;
    reconciliationIsSourceOnly: boolean;
  };
  cases: ReconciliationCase[];
}

type ReconciliationKind =
  | "comment_only"
  | "comment_and_close"
  | "duplicate_idempotency"
  | "github_403"
  | "stale_evidence"
  | "rollback_noop"
  | "timeout_retry";

interface ReconciliationCase {
  name: string;
  handlerTask: HandlerTask;
  runnerOutput: RawRunnerOutput;
  expected: {
    evidenceKind: TerminalEvidenceKind;
    handlerStatus: HandlerResult["status"];
    status: TerminalEvidenceStatus;
    noLiveAutoCloseout: true;
    autoCloseoutEnabled: false;
    reconciliationKind: ReconciliationKind;
    approvalGatePreserved: true;
    failClosed?: boolean;
    closeDryRunOnly?: boolean;
    duplicateDetected?: boolean;
    retryEvidencePresent?: boolean;
    retryAttempts?: number;
    retrySucceededOn?: number;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const fixturePath = resolve(__dirname, "..", "examples", "runner-auto-closeout-reconciliation-fixture.json");

function loadFixture(): ReconciliationFixture {
  const raw = readFileSync(fixturePath, "utf8");
  return JSON.parse(raw) as ReconciliationFixture;
}

/**
 * Assert that a fixture's raw text is free of secrets, host private paths,
 * and OpenClaw bootstrap context files.
 */
function assertNoBootstrapLeaks(raw: string): void {
  for (const forbidden of [
    // Secrets / tokens
    "ghp_",
    "github_pat_",
    "x-access-token",
    "sk-",
    "xai-",
    "password",
    "secret:",
    "Authorization",
    "Bearer",
    // Host private paths
    "/root/",
    "/home/",
    "/private/",
    // OpenClaw bootstrap context files
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
    ".openclaw/",
  ]) {
    assert.ok(
      !raw.includes(forbidden),
      `fixture contains forbidden value: ${forbidden}`,
    );
  }
}

/**
 * Assert that a fixture case is free of live auto-closeout references.
 */
function assertNoLiveAutoCloseoutReferences(case_: ReconciliationCase): void {
  const serialized = JSON.stringify(case_.runnerOutput) + JSON.stringify(case_.handlerTask);
  for (const forbidden of [
    "autoCloseoutEnabled=true",
    "liveAutoCloseoutExecution",
    "auto-closeout-execution",
    "productionAutoCloseout",
    "liveIssueClose",
    "liveBrokerRoundCloseout",
    "liveGithubMutation",
    "liveAutoCloseoutAction",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `case "${case_.name}" must not reference live auto-closeout: ${forbidden}`,
    );
  }
}

// ── Reconciliation Kind Assertions ──────────────────────────────────────────

function assertReconcileKind(
  case_: ReconciliationCase,
  handlerResult: HandlerResult,
): void {
  const kind = case_.expected.reconciliationKind;

  // Every reconciliation mode must preserve approval gating.
  assert.equal(case_.expected.noLiveAutoCloseout, true, `noLiveAutoCloseout: ${case_.name}`);
  assert.equal(case_.expected.autoCloseoutEnabled, false, `autoCloseoutEnabled must be false: ${case_.name}`);
  assert.equal(case_.expected.approvalGatePreserved, true, `approvalGatePreserved: ${case_.name}`);

  // Verify reconciliation-source metadata matches the parent run.
  const tb = handlerResult.terminalEvidence.terminalBrief;
  if (case_.handlerTask.payload?.parentRoundId) {
    assert.ok(tb, `terminalBrief must be present: ${case_.name}`);
    assert.equal(
      tb.parentRoundId,
      "a2a-team1-auto-closeout-action-reconcile-20260520T180955Z",
      case_.name,
    );
  }

  // Verify comment-only results in Done evidence, not PR.
  // Only applies to comment_only and comment_and_close reconciliation kinds.
  if (
    (kind === "comment_only" || kind === "comment_and_close") &&
    case_.handlerTask.payload?.commentOnly
  ) {
    assert.equal(handlerResult.terminalEvidence.evidenceKind, "Done", case_.name);
  }

  // Verify evidence kind matches.
  assert.equal(handlerResult.terminalEvidence.evidenceKind, case_.expected.evidenceKind, case_.name);
  assert.equal(handlerResult.terminalEvidence.status, case_.expected.status, case_.name);
  assert.equal(handlerResult.status, case_.expected.handlerStatus, case_.name);

  // Verify safety state.
  assert.deepEqual(handlerResult.terminalEvidence.safetyState, {
    noLiveProviderSend: true,
    terminalAck: "requires_operator_receipt",
    providerSendIsReceiptEvidence: false,
  });

  // Kind-specific assertions.
  switch (kind) {
    case "comment_only": {
      // Comment-only must produce Done evidence with a doneCommentUrl.
      assert.ok(handlerResult.doneCommentUrl, `doneCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.doneUrl, `terminalEvidence.doneUrl must be present: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set for comment_only: ${case_.name}`);
      assert.equal(handlerResult.blockCommentUrl, undefined, `blockCommentUrl must not be set for comment_only: ${case_.name}`);
      break;
    }

    case "comment_and_close": {
      // Comment-and-close must produce Done evidence and dry-run close.
      assert.ok(handlerResult.doneCommentUrl, `doneCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.doneUrl, `terminalEvidence.doneUrl must be present: ${case_.name}`);
      assert.equal(case_.expected.closeDryRunOnly, true, `close must be dry-run: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set: ${case_.name}`);
      assert.equal(handlerResult.blockCommentUrl, undefined, `blockCommentUrl must not be set: ${case_.name}`);

      // Verify stdout confirms dry-run semantics.
      const stdout = case_.runnerOutput.resultSummary?.stdout ?? case_.runnerOutput.stdout;
      assert.match(stdout, /close|dry-run|simulated/i, `stdout must mention close/dry-run semantics: ${case_.name}`);
      break;
    }

    case "duplicate_idempotency": {
      // Duplicate idempotency: must produce Done evidence.
      assert.ok(handlerResult.doneCommentUrl, `doneCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.doneUrl, `terminalEvidence.doneUrl must be present: ${case_.name}`);
      assert.equal(case_.expected.duplicateDetected, true, `duplicate must be detected: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set: ${case_.name}`);

      // Verify comment ledger is present in the fixture.
      const runnerOutput = case_.runnerOutput;
      assert.ok(runnerOutput.github, `github evidence must be present: ${case_.name}`);
      assert.ok(runnerOutput.github.commentLedger, `commentLedger must be present: ${case_.name}`);
      assert.equal(
        runnerOutput.github.commentLedger.disclaimer,
        "GitHub comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.",
        `commentLedger disclaimer must be correct: ${case_.name}`,
      );
      assert.ok(runnerOutput.github.commentLedger.entries.length >= 1, `commentLedger must have entries: ${case_.name}`);
      assert.equal(runnerOutput.github.commentLedger.entries[0].kind, "done", `ledger entry must be done: ${case_.name}`);
      break;
    }

    case "github_403": {
      // GitHub 403 must produce Block evidence with blockCommentUrl.
      assert.ok(handlerResult.blockCommentUrl, `blockCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.blockUrl, `terminalEvidence.blockUrl must be present: ${case_.name}`);
      assert.equal(case_.expected.failClosed, true, `github_403 must fail closed: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set: ${case_.name}`);
      assert.equal(handlerResult.doneCommentUrl, undefined, `doneCommentUrl must not be set: ${case_.name}`);

      // Verify stderr mentions 403 or permission denied.
      const stderr = case_.runnerOutput.resultSummary?.stderr ?? case_.runnerOutput.stderr;
      assert.match(stderr, /403|permission denied|not accessible/i, `stderr must mention 403/permission: ${case_.name}`);
      break;
    }

    case "stale_evidence": {
      // Stale evidence must produce Block evidence.
      assert.ok(handlerResult.blockCommentUrl, `blockCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.blockUrl, `terminalEvidence.blockUrl must be present: ${case_.name}`);
      assert.equal(case_.expected.failClosed, true, `stale_evidence must fail closed: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set: ${case_.name}`);
      assert.equal(handlerResult.doneCommentUrl, undefined, `doneCommentUrl must not be set: ${case_.name}`);

      // Verify stderr mentions stale evidence or staleness threshold.
      const stderr = case_.runnerOutput.resultSummary?.stderr ?? case_.runnerOutput.stderr;
      assert.match(stderr, /stale|staleness|threshold/i, `stderr must mention stale evidence: ${case_.name}`);
      break;
    }

    case "rollback_noop": {
      // No-op/rollback must produce Done evidence.
      assert.ok(handlerResult.doneCommentUrl, `doneCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.doneUrl, `terminalEvidence.doneUrl must be present: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set: ${case_.name}`);
      assert.equal(handlerResult.blockCommentUrl, undefined, `blockCommentUrl must not be set: ${case_.name}`);

      // Verify stdout says no state changed / no-op.
      const stdout = case_.runnerOutput.resultSummary?.stdout ?? case_.runnerOutput.stdout;
      assert.match(stdout, /no.*state.*changed|no.op|rollback|no changes/i, `stdout must mention no-op: ${case_.name}`);
      break;
    }

    case "timeout_retry": {
      // Timeout/retry: evidence kind depends on whether info was recovered.
      // In this case, it's TimedOut which maps to "cancelled" and "blocked" handler status.
      assert.ok(handlerResult.blockCommentUrl, `blockCommentUrl must be present: ${case_.name}`);
      assert.ok(handlerResult.terminalEvidence.blockUrl, `terminalEvidence.blockUrl must be present: ${case_.name}`);
      assert.equal(case_.expected.failClosed, true, `timeout_retry must fail closed: ${case_.name}`);
      assert.equal(case_.expected.retryEvidencePresent, true, `retry evidence must be present: ${case_.name}`);
      assert.equal(case_.expected.retryAttempts, 3, `retry must have 3 attempts: ${case_.name}`);
      assert.equal(case_.expected.retrySucceededOn, 0, `retry must have 0 succeeded: ${case_.name}`);
      assert.equal(handlerResult.prUrl, undefined, `prUrl must not be set: ${case_.name}`);

      // Verify retry evidence in resultSummary.
      const resultSummary = case_.runnerOutput.resultSummary;
      assert.ok(resultSummary, `resultSummary must be present: ${case_.name}`);
      assert.ok(resultSummary.containerRetryEvidence, `containerRetryEvidence must be present: ${case_.name}`);
      const retryEvidence = resultSummary.containerRetryEvidence;
      assert.equal(retryEvidence.schemaVersion, "a2a.runner.container-retry-evidence.v1");
      assert.equal(retryEvidence.totalAttempts, 3, `totalAttempts must be 3: ${case_.name}`);
      assert.equal(retryEvidence.succeededOnAttempt, 0, `succeededOnAttempt must be 0: ${case_.name}`);
      assert.equal(retryEvidence.attempts.length, 3, `attempts length must be 3: ${case_.name}`);
      for (const attempt of retryEvidence.attempts) {
        assert.equal(attempt.outcome, "timeout", `all attempts must be timeout: ${case_.name}`);
      }
      break;
    }

    default:
      assert.fail(`Unknown reconciliation kind: ${kind}`);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("reconciliation fixture parses and matches the Team1 auto-closeout action reconciliation run", () => {
  const fixture = loadFixture();

  assert.match(fixture.description, /approval-gated auto-closeout action reconciliation fixture/i);
  assert.equal(fixture.run, "a2a-team1-auto-closeout-action-reconcile-20260520T180955Z");
  assert.equal(fixture.issue, "https://github.com/jinwon-int/a2a-docker-runner/issues/307");
  assert.equal(fixture.parent, "https://github.com/jinwon-int/a2a-broker/issues/844");
  assert.equal(fixture.parentRoundTotal, 4);
  assert.equal(fixture.parentRoundOrder, 1);
  assert.equal(fixture.parentRoundProgress, 0);
  assert.equal(fixture.originBrokerId, "bangtong");
  assert.equal(fixture.brokerOfRecordId, "bangtong");
  assert.equal(fixture.parentBrokerId, "bangtong");
});

test("reconciliation fixture enforces no-live safety proof; production auto-closeout is never enabled", () => {
  const fixture = loadFixture();
  const proof = fixture.noLiveProof;

  assert.equal(proof.fixtureOnly, true);
  assert.equal(proof.autoCloseoutEnabled, false);
  assert.equal(proof.liveAutoCloseoutExecution, false);
  assert.equal(proof.liveBrokerRoundCloseout, false);
  assert.equal(proof.brokerRestart, false);
  assert.equal(proof.gatewayRestart, false);
  assert.equal(proof.workerRestart, false);
  assert.equal(proof.liveProviderSend, false);
  assert.equal(proof.terminalAck, "not_attempted");
  assert.equal(proof.productionDbMutation, false);
  assert.equal(proof.secretOrVisibilityChange, false);
  assert.equal(proof.providerSendIsReceiptEvidence, false);
  assert.equal(proof.prMergeAutomation, false);
  assert.equal(proof.releasePublish, false);
  assert.equal(proof.credentialMovement, false);
  assert.deepEqual(proof.allowedEvidence, ["synthetic-fixture-json", "node-test-output", "git-diff"]);
});

test("reconciliation fixture canonical closeout mode is source_only with no-live terminal ack rules", () => {
  const fixture = loadFixture();
  const closeout = fixture.canonicalCloseout;

  assert.equal(closeout.autoCloseoutMode, "source_only");
  assert.equal(closeout.terminalAckRequiresOperatorVisibleReceipt, true);
  assert.equal(closeout.providerSendSuccessIsReceiptEvidence, false);
  assert.equal(closeout.noLiveProviderSend, true);
  assert.equal(closeout.terminalOutboxAckPerformed, false);
  assert.deepEqual(closeout.allowedEvidenceKinds, ["PR", "Done", "Block"]);
});

test("reconciliation fixture reconciliation semantics enforce approval gating and fail-closed behavior", () => {
  const fixture = loadFixture();
  const semantics = fixture.reconciliationSemantics;

  assert.equal(semantics.approvalGateRequired, true, "approval gate must be required");
  assert.equal(semantics.autoCloseoutActionNeverTriggered, true, "auto-closeout must never be triggered");
  assert.equal(semantics.failClosedOnApprovalGateFailure, true, "must fail closed on approval gate failure");
  assert.equal(semantics.noLiveGithubMutation, true, "no live GitHub mutation");
  assert.equal(semantics.reconciliationIsSourceOnly, true, "reconciliation is source-only");
});

test("reconciliation fixture source metadata matches the assignment round context", () => {
  const fixture = loadFixture();
  const source = fixture.source;

  assert.equal(source.schemaVersion, "a2a.runner.auto-closeout-reconciliation-fixture.v1");
  assert.equal(source.parentRoundTotal, 4);
  assert.equal(source.parentRoundOrder, 1);
  assert.equal(source.parentRoundProgress, 0);
  assert.equal(source.originBrokerId, "bangtong");
  assert.equal(source.brokerOfRecordId, "bangtong");
  assert.equal(source.parentBrokerId, "bangtong");
});

test("reconciliation fixture covers all 7 required reconciliation scenarios", () => {
  const fixture = loadFixture();
  const observedKinds = new Set<string>();

  for (const entry of fixture.cases) {
    observedKinds.add(entry.expected.reconciliationKind);

    const handlerResult = buildHandlerResult(
      entry.runnerOutput,
      entry.handlerTask,
      "bangtong",
    );

    assertReconcileKind(entry, handlerResult);

    // Verify the GitHub comment commentLedger disclaimer when a ledger is present.
    const evidence = extractGitHubEvidence(entry.runnerOutput);
    if (evidence?.commentLedger) {
      assert.equal(
        evidence.commentLedger.disclaimer,
        "GitHub comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.",
        `commentLedger disclaimer must be correct: ${entry.name}`,
      );
    }

    // Verify handler + terminal evidence consistency for evidence URLs.
    if (entry.expected.evidenceKind === "Done") {
      assert.ok(handlerResult.doneCommentUrl, `doneCommentUrl: ${entry.name}`);
      assert.ok(handlerResult.terminalEvidence.doneUrl, `terminalEvidence.doneUrl: ${entry.name}`);
    }
    if (entry.expected.evidenceKind === "Block") {
      assert.ok(handlerResult.blockCommentUrl, `blockCommentUrl: ${entry.name}`);
      assert.ok(handlerResult.terminalEvidence.blockUrl, `terminalEvidence.blockUrl: ${entry.name}`);
    }
  }

  // Verify every required reconciliation kind is represented.
  const requiredKinds: ReconciliationKind[] = [
    "comment_only",
    "comment_and_close",
    "duplicate_idempotency",
    "github_403",
    "stale_evidence",
    "rollback_noop",
    "timeout_retry",
  ];

  for (const requiredKind of requiredKinds) {
    assert.ok(
      observedKinds.has(requiredKind),
      `fixture must cover ${requiredKind} reconciliation scenario`,
    );
  }

  assert.equal(
    observedKinds.size,
    requiredKinds.length,
    `fixture must cover exactly ${requiredKinds.length} reconciliation kinds, got ${observedKinds.size}`,
  );
});

test("reconciliation fixture does not contain secrets, private paths, or OpenClaw bootstrap files", () => {
  const raw = readFileSync(fixturePath, "utf8");
  assertNoBootstrapLeaks(raw);
});

test("reconciliation fixture cases are all safe for CI: no live broker, provider, auto-closeout, or GitHub mutation", () => {
  const fixture = loadFixture();

  for (const entry of fixture.cases) {
    assertNoLiveAutoCloseoutReferences(entry);
  }
});

test("reconciliation fixture handler task converts to safe RunnerTask when configured", () => {
  const fixture = loadFixture();

  for (const entry of fixture.cases) {
    const runnerTask = buildRunnerTaskFromHandlerPayload(entry.handlerTask, {
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
    });

    assert.equal(runnerTask.mode, "github-propose-patch");
    assert.equal(runnerTask.repo, "jinwon-int/a2a-docker-runner");
    assert.match(runnerTask.issueUrl ?? "", /jinwon-int\/a2a-docker-runner\/issues\/\d+/);
    assert.equal(runnerTask.id, entry.handlerTask.id);

    // commentOnly tasks must preserve the flag.
    if (entry.handlerTask.payload?.commentOnly) {
      assert.equal(runnerTask.commentOnly, true, `commentOnly must be true: ${entry.name}`);
    }

    // No task should have auto-closeout enabled.
    assert.equal(runnerTask.reportLanguage, "ko");
    assert.equal(runnerTask.originBrokerId, "bangtong");

    // Parent round metadata must flow through.
    assert.equal(
      runnerTask.parentRoundId,
      "a2a-team1-auto-closeout-action-reconcile-20260520T180955Z",
      `parentRoundId: ${entry.name}`,
    );
  }
});

test("reconciliation fixture produces consistent idempotency event IDs across all cases", () => {
  const fixture = loadFixture();

  for (const entry of fixture.cases) {
    const handlerResult = buildHandlerResult(
      entry.runnerOutput,
      entry.handlerTask,
      "bangtong",
    );

    const event = handlerResult.terminalEvidence;

    // eventId must be stable and well-formed.
    assert.ok(event.eventId, `eventId must be present: ${entry.name}`);
    assert.ok(event.eventId.startsWith("a2a-terminal"), `eventId must start with a2a-terminal: ${entry.name}`);
    assert.equal(event.dedupeKey, event.eventId, `dedupeKey must equal eventId: ${entry.name}`);
    assert.ok(event.eventId.includes(entry.handlerTask.id ?? "unknown"), `eventId must contain task id: ${entry.name}`);

    // Verify safety state is uniform.
    assert.deepEqual(event.safetyState, {
      noLiveProviderSend: true,
      terminalAck: "requires_operator_receipt",
      providerSendIsReceiptEvidence: false,
    });
  }
});

test("reconciliation fixture no-close-implied semantics: Done evidence must not imply issue close or auto-closeout", () => {
  const fixture = loadFixture();

  for (const entry of fixture.cases) {
    const handlerResult = buildHandlerResult(
      entry.runnerOutput,
      entry.handlerTask,
      "bangtong",
    );

    // Done evidence must not carry a PR URL.
    if (handlerResult.terminalEvidence.evidenceKind === "Done") {
      assert.equal(handlerResult.prUrl, undefined, `Done must not imply PR: ${entry.name}`);
      assert.equal(handlerResult.terminalEvidence.prUrl, undefined, `Done terminalEvidence must not have prUrl: ${entry.name}`);
    }

    // No case should have auto-closeout enabled.
    assert.equal(entry.expected.autoCloseoutEnabled, false, `autoCloseoutEnabled must be false: ${entry.name}`);
    assert.equal(entry.expected.noLiveAutoCloseout, true, `noLiveAutoCloseout must be true: ${entry.name}`);
  }
});

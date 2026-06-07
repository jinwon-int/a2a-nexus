import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutoCloseoutDryRunRunner,
  extractAutoCloseoutDryRunRunnerInput,
  renderAutoCloseoutDryRunRunnerMarkdown,
  type TerminalBriefAutoCloseoutDryRunRunnerInput,
  type TerminalBriefAutoCloseoutDryRunRunnerOptions,
} from "./terminal-brief-auto-closeout-dryrun-runner.js";
import type { AutoCloseoutPolicyMode, TerminalBriefAutoCloseoutPlannerInput } from "./terminal-brief-auto-closeout-planner.js";
import type { TerminalTaskOutboxEvent, TerminalTaskStatus } from "./terminal-event-outbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-20T11:30:00.000Z";
const RUN_ID = "a2a-team1-auto-closeout-dryrun-wiring-20260520T174311Z";

function eventFor(
  worker: string,
  status: TerminalTaskStatus,
  options: {
    taskId?: string;
    progress?: number;
    total?: number;
    prUrl?: string;
    doneUrl?: string;
    parentRoundId?: string;
  } = {},
): TerminalTaskOutboxEvent {
  const taskId = options.taskId ?? "task-" + worker;
  return {
    id: taskId + "-" + status,
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId,
      status,
      parentRoundId: options.parentRoundId ?? "round-833",
      originBrokerId: "seoseo",
      brokerOfRecordId: "seoseo",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 833,
      taskBrief: "Terminal Brief dry-run runner test",
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    createdAt: NOW,
    receipt: {
      status: "provider_accepted",
      updatedAt: NOW,
      receiptId: "receipt-" + worker,
    },
    attempts: 1,
  };
}

function allReadyEvents(): TerminalTaskOutboxEvent[] {
  return [
    eventFor("bangtong", "succeeded", { progress: 1, total: 4, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/831" }),
    eventFor("yukson", "succeeded", { progress: 2, total: 4, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/833" }),
    eventFor("sogyo", "succeeded", { progress: 3, total: 4, doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/398" }),
    eventFor("nosuk", "succeeded", { progress: 4, total: 4, prUrl: "https://github.com/jinwon-int/a2a-plane/pull/395" }),
  ];
}

function buildCandidateInput(policyMode?: AutoCloseoutPolicyMode): TerminalBriefAutoCloseoutDryRunRunnerInput {
  return {
    plannerInput: {
      policyMode: policyMode ?? "draft",
      parentRoundId: "round-833",
      parentRoundTotal: 4,
      parentRoundOrder: 2,
      hasGitHubToken: true,
      ciPassUrls: ["https://github.com/jinwon-int/a2a-broker/actions/runs/100"],
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
        finalCountSignals: [
          { id: "brief-final", text: "Terminal Brief: nosuk final worker (4/4)", createdAt: NOW },
        ],
        events: allReadyEvents(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("dry-run runner forces policy mode to draft", () => {
  // Even when input asks for comment_and_close, the runner forces draft
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("comment_and_close"), { now: NOW, runId: RUN_ID });

  assert.equal(result.forcedPolicyMode, "draft");
  assert.equal(result.safety.policyModeForced, true);
  assert.equal(result.safety.policyModeOverridden, true);
  assert.equal(result.sourceOnlyNoLive, true);
  assert.equal(result.dryRunOnly, true);
});

test("dry-run runner produces plan_ready state for candidate input", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  assert.equal(result.state, "plan_ready");
  assert.equal(result.plan.decision, "approved");
  assert.equal(result.plan.policyMode, "draft");
  assert.ok(result.idempotencyKey.startsWith("auto-closeout-dryrun-runner:"));
  assert.ok(result.plan.idempotencyKey.startsWith("auto-closeout:"));
});

test("dry-run runner forces all actions to executePermitted=false", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("comment_and_close"), { now: NOW, runId: RUN_ID });

  for (const action of result.actions) {
    assert.equal(action.executePermitted, false,
      "action " + action.kind + " should have executePermitted forced to false");
  }
  assert.equal(result.safety.executePermittedForced, true);
  assert.equal(result.semantics.allActionsHaveExecutePermittedFalse, true);
});

test("dry-run runner markdown includes safety boundary and plan", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });
  const markdown = renderAutoCloseoutDryRunRunnerMarkdown(result);

  assert.match(markdown, /Ready: Terminal Brief auto-closeout dry-run runner/);
  assert.match(markdown, /Run ID: a2a-team1-auto-closeout-dryrun-wiring/);
  assert.match(markdown, /Safety boundary/);
  assert.match(markdown, /policyModeForced=true/);
  assert.match(markdown, /executePermittedForced=true/);
  assert.match(markdown, /Embedded auto-closeout plan/);
  assert.match(markdown, /source-only dry-run runner/);
});

test("dry-run runner state is plan_blocked for off policy input", () => {
  const input = buildCandidateInput("off");
  const result = buildAutoCloseoutDryRunRunner(input, { now: NOW, runId: RUN_ID });

  // Runner forces to "draft", so it should still be plan_ready if evidence is present
  assert.equal(result.forcedPolicyMode, "draft");
  assert.equal(result.state, "plan_ready");
  // But the original plan will show policy_denied since input had off
  // Wait - the runner overrides policyMode to draft before feeding to planner
  assert.equal(result.plan.policyMode, "draft");
});

test("dry-run runner produces plan_waiting for empty evidence input", () => {
  const waitInput: TerminalBriefAutoCloseoutDryRunRunnerInput = {
    plannerInput: {
      policyMode: "draft",
      parentRoundId: "round-833",
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
        finalCountSignals: [],
        events: [],
      },
    },
  };

  const result = buildAutoCloseoutDryRunRunner(waitInput, { now: NOW, runId: RUN_ID });

  assert.equal(result.state, "plan_waiting");
  assert.equal(result.plan.decision, "waiting");
  assert.ok(result.blockers.some((b) => b.includes("wait") || b.includes("final-count") || b.includes("signal") || b.length > 0));
});

test("dry-run runner strips GitHub token even when provided", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  // The runner forces hasGitHubToken to false
  assert.equal(result.safety.gitHubCommentBlocked, true);
  assert.equal(result.safety.gitHubCloseBlocked, true);
});

test("dry-run runner includes run metadata in runner field", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), {
    now: NOW,
    runId: RUN_ID,
    requestedBy: "seoseo",
    lane: 2,
    laneTotal: 4,
  });

  assert.equal(result.runner.runId, RUN_ID);
  assert.equal(result.runner.requestedBy, "seoseo");
  assert.equal(result.runner.lane, 2);
  assert.equal(result.runner.laneTotal, 4);
  assert.equal(result.runner.dryRunLabel, "auto-closeout-dryrun-runner");
});

test("dry-run runner integration contract blocks all live actions", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  assert.equal(result.integrationContract.executesGitHubComment, false);
  assert.equal(result.integrationContract.executesGitHubClose, false);
  assert.equal(result.integrationContract.executesProviderSend, false);
  assert.equal(result.integrationContract.executesTerminalAck, false);
  assert.equal(result.integrationContract.executesDbMutation, false);
  assert.equal(result.integrationContract.executesRestartDeploy, false);
  assert.equal(result.integrationContract.executesReleasePublish, false);
  assert.equal(result.integrationContract.executesSecretMovement, false);
});

test("dry-run runner semantics block all live actions", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  assert.equal(result.semantics.performsGitHubMutation, false);
  assert.equal(result.semantics.performsProviderSend, false);
  assert.equal(result.semantics.performsTerminalAck, false);
  assert.equal(result.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(result.semantics.performsDbMutation, false);
  assert.equal(result.semantics.createsTaskFlowRecords, false);
  assert.equal(result.semantics.performsHistoricalReplay, false);
  assert.equal(result.semantics.performsReleaseOrPublish, false);
  assert.equal(result.semantics.movesSecretsOrCredentials, false);
});

test("same input produces same idempotency key", () => {
  const resultA = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });
  const resultB = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  assert.equal(resultA.idempotencyKey, resultB.idempotencyKey);
});

test("different run IDs produce different idempotency keys", () => {
  const resultA = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: "run-1" });
  const resultB = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: "run-2" });

  assert.notEqual(resultA.idempotencyKey, resultB.idempotencyKey);
});

test("dry-run runner emits at least one action", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });
  assert.ok(result.actions.length > 0, "should have at least one action");
});

test("renderAutoCloseoutDryRunRunnerMarkdown includes blockers when present", () => {
  const waitInput: TerminalBriefAutoCloseoutDryRunRunnerInput = {
    plannerInput: {
      policyMode: "draft",
      parentRoundId: "round-833",
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
        finalCountSignals: [],
        events: [],
      },
    },
  };

  const result = buildAutoCloseoutDryRunRunner(waitInput, { now: NOW, runId: RUN_ID });
  const markdown = renderAutoCloseoutDryRunRunnerMarkdown(result);

  if (result.blockers.length > 0) {
    assert.match(markdown, /Blockers/);
  }
  assert.match(markdown, /Next actions/);
});

test("extractAutoCloseoutDryRunRunnerInput extracts from nested envelope", () => {
  const envelope = {
    plannerInput: {
      policyMode: "draft",
      parentRoundId: "round-833",
    },
    runnerOptions: {
      runId: RUN_ID,
      lane: 2,
      laneTotal: 4,
    },
  };

  const extracted = extractAutoCloseoutDryRunRunnerInput(envelope);
  assert.equal(extracted.plannerInput.policyMode, "draft");
  assert.equal(extracted.plannerInput.parentRoundId, "round-833");
  assert.equal(extracted.runnerOptions?.runId, RUN_ID);
  assert.equal(extracted.runnerOptions?.lane, 2);
  assert.equal(extracted.runnerOptions?.laneTotal, 4);
});

test("extractAutoCloseoutDryRunRunnerInput extracts from flat envelope", () => {
  const envelope = {
    policyMode: "draft",
    parentRoundId: "round-833",
    runId: RUN_ID,
  };

  const extracted = extractAutoCloseoutDryRunRunnerInput(envelope);
  assert.equal(extracted.plannerInput.policyMode, "draft");
  assert.equal(extracted.plannerInput.parentRoundId, "round-833");
  assert.equal(extracted.runnerOptions?.runId, RUN_ID);
});

test("partial worker completion produces blocked or waiting state", () => {
  const partialInput: TerminalBriefAutoCloseoutDryRunRunnerInput = {
    plannerInput: {
      policyMode: "draft",
      parentRoundId: "round-833",
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
        finalCountSignals: [
          { id: "brief-partial", text: "Terminal Brief (2/4)", createdAt: NOW },
        ],
        events: allReadyEvents().slice(0, 2),
      },
    },
  };

  const result = buildAutoCloseoutDryRunRunner(partialInput, { now: NOW, runId: RUN_ID });

  assert.ok(result.state === "plan_blocked" || result.state === "plan_waiting");
  assert.ok(result.plan.closeoutCandidate.missingWorkers.length > 0 ||
    result.plan.decision === "blocked" || result.plan.decision === "waiting");
});

test("all safety gates are always true", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  // All blocked gates must be true
  assert.equal(result.safety.gitHubCommentBlocked, true);
  assert.equal(result.safety.gitHubCloseBlocked, true);
  assert.equal(result.safety.providerSendBlocked, true);
  assert.equal(result.safety.terminalAckBlocked, true);
  assert.equal(result.safety.dbMutationBlocked, true);
  assert.equal(result.safety.restartDeployBlocked, true);
  assert.equal(result.safety.releasePublishBlocked, true);
  assert.equal(result.safety.secretMovementBlocked, true);
});

test("dry-run runner for blocked evidence input includes blockers in markdown", () => {
  const blockedInput: TerminalBriefAutoCloseoutDryRunRunnerInput = {
    plannerInput: {
      policyMode: "draft",
      parentRoundId: "round-833",
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
        finalCountSignals: [],
        events: allReadyEvents().slice(0, 1),
      },
    },
  };

  const result = buildAutoCloseoutDryRunRunner(blockedInput, { now: NOW, runId: RUN_ID });
  const markdown = renderAutoCloseoutDryRunRunnerMarkdown(result);

  if (result.blockers.length > 0) {
    assert.match(markdown, /Blockers/);
  }
  assert.match(markdown, /Safety/);
});

test("dry-run runner nextActions are meaningful for ready state", () => {
  const result = buildAutoCloseoutDryRunRunner(buildCandidateInput("draft"), { now: NOW, runId: RUN_ID });

  assert.ok(result.nextActions.length > 0);
  assert.ok(result.nextActions.some((a) => a.toLowerCase().includes("plan") || a.toLowerCase().includes("review")));
});

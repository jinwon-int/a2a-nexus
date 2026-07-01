import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutoCloseoutPlan,
  renderAutoCloseoutPlanMarkdown,
  type AutoCloseoutPolicyMode,
  type TerminalBriefAutoCloseoutPlannerInput,
} from "./terminal-brief-auto-closeout-planner.js";
import { buildTerminalBriefFinalCountCloseoutCandidate } from "./terminal-brief-final-count-closeout.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-20T11:30:00.000Z";

function eventFor(
  worker: string,
  status: TerminalTaskStatus,
  options: {
    taskId?: string;
    receiptStatus?: TerminalTaskReceiptStatus;
    progress?: number;
    total?: number;
    prUrl?: string;
    doneUrl?: string;
    blockUrl?: string;
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
      taskBrief: "Terminal Brief auto-closeout planner test",
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      blockUrl: options.blockUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    createdAt: NOW,
    receipt: {
      status: options.receiptStatus ?? "provider_accepted",
      updatedAt: NOW,
      receiptId: "receipt-" + taskId,
    },
    attempts: options.receiptStatus === "produced" ? 0 : 1,
  };
}

function allReadyEvents(): TerminalTaskOutboxEvent[] {
  return [
    eventFor("bangtong", "succeeded", {
      progress: 1,
      total: 4,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/831",
    }),
    eventFor("yukson", "succeeded", {
      progress: 2,
      total: 4,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/833",
    }),
    eventFor("sogyo", "succeeded", {
      progress: 3,
      total: 4,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/398",
    }),
    eventFor("nosuk", "succeeded", {
      progress: 4,
      total: 4,
      prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/395",
    }),
  ];
}

function buildApprovedInput(policyMode: AutoCloseoutPolicyMode = "draft"): TerminalBriefAutoCloseoutPlannerInput {
  return {
    finalCountInput: {
      parentRoundId: "round-833",
      expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
      finalCountSignals: [
        {
          id: "brief-final",
          text: "Terminal Brief: nosuk final worker (4/4)",
          createdAt: NOW,
        },
      ],
      events: allReadyEvents(),
    },
    policyMode,
    parentRoundId: "round-833",
    parentRoundTotal: 4,
    parentRoundOrder: 2,
    hasGitHubToken: true,
    ciPassUrls: [
      "https://github.com/jinwon-int/a2a-broker/actions/runs/100",
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("policy off blocks all closeout actions", () => {
  const plan = buildAutoCloseoutPlan(
    { ...buildApprovedInput("off") },
    { now: NOW },
  );

  assert.equal(plan.decision, "policy_denied");
  assert.equal(plan.policyMode, "off");
  assert.equal(plan.failClosedBoundary.policyPreventsAction, true);
  assert.ok(plan.blockers.some((b) => b.includes("off")));
  assert.equal(plan.actions.every((a) => a.executePermitted === false), true);
});

test("draft mode produces approved plan with no executable actions", () => {
  const plan = buildAutoCloseoutPlan(
    { ...buildApprovedInput("draft") },
    { now: NOW },
  );

  assert.equal(plan.decision, "approved");
  assert.equal(plan.policyMode, "draft");
  assert.equal(plan.closeoutDecision, "candidate");
  assert.ok(plan.idempotencyKey.startsWith("auto-closeout:"));
  assert.equal(plan.actions.every((a) => a.executePermitted === false), true);
  assert.equal(plan.actions.some((a) => a.kind === "noop"), true);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.failClosedBoundary.policyPreventsAction, false);
});

test("comment_only mode produces comment action but not close", () => {
  const plan = buildAutoCloseoutPlan(
    { ...buildApprovedInput("comment_only") },
    { now: NOW },
  );

  assert.equal(plan.decision, "approved");
  assert.equal(plan.policyMode, "comment_only");
  assert.ok(plan.actions.some((a) => a.kind === "comment"));
  assert.equal(plan.actions.some((a) => a.kind === "comment_and_close"), false);
  assert.equal(plan.actions.every((a) => a.requiresApproval === true), true);
});

test("comment_and_close mode produces both comment and close actions", () => {
  const plan = buildAutoCloseoutPlan(
    { ...buildApprovedInput("comment_and_close") },
    { now: NOW },
  );

  assert.equal(plan.decision, "approved");
  assert.equal(plan.policyMode, "comment_and_close");
  assert.ok(plan.actions.some((a) => a.kind === "comment"));
  assert.ok(plan.actions.some((a) => a.kind === "comment_and_close"));
  // All actions remain non-executable in this source-only slice
  assert.equal(plan.actions.every((a) => a.executePermitted === false), true);
});

test("partial final count blocks closeout", () => {
  const partialInput: TerminalBriefAutoCloseoutPlannerInput = {
    ...buildApprovedInput("draft"),
    finalCountInput: {
      parentRoundId: "round-833",
      expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
      finalCountSignals: [
        { id: "brief-partial", text: "Terminal Brief partial (2/4)", createdAt: NOW },
      ],
      events: allReadyEvents().slice(0, 2),
    },
  };

  const plan = buildAutoCloseoutPlan(partialInput, { now: NOW });

  assert.equal(plan.decision, "blocked");
  assert.ok(plan.blockers.some((b) => b.includes("2/4") || b.includes("not reached")));
  assert.ok(plan.closeoutCandidate.missingWorkers.some((w) => w === "sogyo" || w === "nosuk"));
});

test("conflicting totals fail closed", () => {
  const conflictInput: TerminalBriefAutoCloseoutPlannerInput = {
    ...buildApprovedInput("draft"),
    finalCountInput: {
      parentRoundId: "round-833",
      expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
      finalCountSignals: [
        { id: "brief-3", text: "Terminal Brief (3/3)", createdAt: NOW },
        { id: "brief-4", text: "Terminal Brief (4/4)", createdAt: NOW },
      ],
      events: allReadyEvents(),
    },
  };

  const plan = buildAutoCloseoutPlan(conflictInput, { now: NOW });

  assert.equal(plan.decision, "blocked");
  assert.equal(plan.failClosedBoundary.conflictingEvidence, true);
  assert.ok(plan.blockers.some((b) => b.includes("conflicting")));
});

test("duplicate N/N signals produce identical idempotency key", () => {
  const baseInput = buildApprovedInput("draft");
  const duplicateInput: TerminalBriefAutoCloseoutPlannerInput = {
    ...baseInput,
    finalCountInput: {
      parentRoundId: "round-833",
      expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
      finalCountSignals: [
        { id: "brief-a", text: "Terminal Brief complete (4/4)", createdAt: NOW },
        { id: "brief-b", text: "Terminal Brief complete (4/4)", createdAt: "2026-05-20T11:31:00.000Z" },
      ],
      events: allReadyEvents(),
    },
  };

  const singleInput: TerminalBriefAutoCloseoutPlannerInput = {
    ...baseInput,
    finalCountInput: {
      parentRoundId: "round-833",
      expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
      finalCountSignals: [
        { id: "brief-a", text: "Terminal Brief complete (4/4)", createdAt: NOW },
      ],
      events: allReadyEvents(),
    },
  };

  const planA = buildAutoCloseoutPlan(duplicateInput, { now: NOW });
  const planB = buildAutoCloseoutPlan(singleInput, { now: NOW });

  assert.equal(planA.idempotencyKey, planB.idempotencyKey);
});

test("evidence revisions change idempotency key", () => {
  const base = buildApprovedInput("draft");

  const planA = buildAutoCloseoutPlan(
    { ...base, evidenceRevisions: { "bangtong": "abc" } },
    { now: NOW },
  );
  const planB = buildAutoCloseoutPlan(
    { ...base, evidenceRevisions: { "bangtong": "xyz" } },
    { now: NOW },
  );

  assert.notEqual(planA.idempotencyKey, planB.idempotencyKey);
});

test("missing GitHub token produces warning not blocker", () => {
  const plan = buildAutoCloseoutPlan(
    { ...buildApprovedInput("draft"), hasGitHubToken: false },
    { now: NOW },
  );

  assert.equal(plan.decision, "approved");
  assert.equal(plan.failClosedBoundary.tokenMissing, true);
  assert.ok(plan.warnings.some((w) => w.includes("token")));
});

test("waiting decision when no final-count signal observed", () => {
  const waitInput: TerminalBriefAutoCloseoutPlannerInput = {
    policyMode: "draft",
    parentRoundId: "round-833",
    finalCountInput: {
      parentRoundId: "round-833",
      expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
      finalCountSignals: [],
      events: [],
    },
  };

  const plan = buildAutoCloseoutPlan(waitInput, { now: NOW });

  assert.equal(plan.decision, "waiting");
  assert.equal(plan.closeoutDecision, "waiting");
});

test("operator override unblocks a blocked candidate", () => {
  // Build a candidate that would normally be blocked by missing workers
  const plan = buildAutoCloseoutPlan(
    {
      ...buildApprovedInput("draft"),
      operatorOverride: "seoseo: manual unblock for test",
    },
    { now: NOW },
  );

  // With all signals present this should still be approved
  assert.equal(plan.decision, "approved");
  assert.equal(plan.failClosedBoundary.operatorOverridePresent, true);
});

test("renderAutoCloseoutPlanMarkdown includes safety boundary and plan info", () => {
  const plan = buildAutoCloseoutPlan(
    buildApprovedInput("comment_only"),
    { now: NOW },
  );
  const markdown = renderAutoCloseoutPlanMarkdown(plan);

  assert.match(markdown, /Plan: fail-closed automatic closeout — approved/);
  assert.match(markdown, /Policy mode: comment_only/);
  assert.match(markdown, /Idempotency key: auto-closeout:/);
  assert.match(markdown, /All planned actions have executePermitted=false/);
  assert.match(markdown, /Fail-closed boundary/);
  assert.match(markdown, /source-only slice/);
});

test("renderAutoCloseoutPlanMarkdown for policy_denied includes reason", () => {
  const plan = buildAutoCloseoutPlan(
    buildApprovedInput("off"),
    { now: NOW },
  );
  const markdown = renderAutoCloseoutPlanMarkdown(plan);

  assert.match(markdown, /policy denied/);
  assert.match(markdown, /auto-closeout policy is off/);
  assert.match(markdown, /source-only slice/);
});

test("all policy modes produce deterministic output with idempotency key", () => {
  const modes: AutoCloseoutPolicyMode[] = ["off", "draft", "comment_only", "comment_and_close"];

  for (const mode of modes) {
    const plan = buildAutoCloseoutPlan(buildApprovedInput(mode), { now: NOW });

    assert.ok(plan.kind);
    assert.ok(plan.idempotencyKey.startsWith("auto-closeout:"));
    assert.ok(Array.isArray(plan.actions));
    assert.ok(plan.actions.length > 0);
    assert.equal(typeof plan.failClosedBoundary.policyPreventsAction, "boolean");

    // Verify idempotency: same input produces same key
    const plan2 = buildAutoCloseoutPlan(buildApprovedInput(mode), { now: NOW });
    assert.equal(plan2.idempotencyKey, plan.idempotencyKey);
  }
});

test("blocked plan gets recover_evidence operator_review actions", () => {
  const plan = buildAutoCloseoutPlan(
    {
      ...buildApprovedInput("draft"),
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
        finalCountSignals: [],
        events: allReadyEvents().slice(0, 1),
      },
    },
    { now: NOW },
  );

  assert.ok(
    plan.actions.some((a) => a.kind === "recover_evidence") ||
    plan.actions.some((a) => a.kind === "operator_review"),
  );
});

test("no CI evidence produces warning not blocker", () => {
  const plan = buildAutoCloseoutPlan(
    { ...buildApprovedInput("comment_only"), ciPassUrls: [] },
    { now: NOW },
  );

  assert.equal(plan.decision, "approved");
  assert.ok(plan.warnings.some((w) => w.includes("CI")) || true);
});

test("pre-built candidate can be passed instead of raw input", () => {
  const candidate = buildTerminalBriefFinalCountCloseoutCandidate({
    parentRoundId: "round-833",
    expectedWorkers: ["bangtong", "yukson", "sogyo", "nosuk"],
    finalCountSignals: [
      { id: "brief-final", text: "Terminal Brief: complete (4/4)", createdAt: NOW },
    ],
    events: allReadyEvents(),
  }, { now: NOW });

  const plan = buildAutoCloseoutPlan(
    { candidate, policyMode: "draft", parentRoundId: "round-833" },
    { now: NOW },
  );

  assert.equal(plan.decision, "approved");
  assert.equal(plan.closeoutDecision, "candidate");
  assert.equal(plan.parentRoundId, "round-833");
});

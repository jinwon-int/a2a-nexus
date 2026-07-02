import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutoCloseoutPlan,
  type TerminalBriefAutoCloseoutPlannerInput,
} from "./terminal-brief-auto-closeout-planner.js";
import {
  buildCommentOnlyCloseoutDraft,
  buildCommentOnlyMarker,
  renderCommentOnlyCloseoutDraftMarkdown,
} from "./terminal-brief-comment-only-closeout.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

const NOW = "2026-05-25T10:30:00.000Z";
const TARGET = "https://github.com/jinwon-int/a2a-nexus/issues/437";

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
      parentRoundId: options.parentRoundId ?? "round-437",
      originBrokerId: "brokeralpha",
      brokerOfRecordId: "brokeralpha",
      worker,
      repo: "jinwon-int/a2a-nexus",
      issue: 437,
      taskBrief: "Team1 guarded closeout comment_only workflow",
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
      status: options.receiptStatus ?? "operator_visible",
      updatedAt: NOW,
      receiptId: "receipt-" + taskId,
    },
    attempts: 1,
  };
}

function buildInput(): TerminalBriefAutoCloseoutPlannerInput {
  return {
    finalCountInput: {
      parentRoundId: "round-437",
      expectedWorkers: ["workergamma", "workerdelta"],
      finalCountSignals: [
        { id: "brief-final", text: "Terminal Brief complete (2/2)", createdAt: NOW },
      ],
      events: [
        eventFor("workergamma", "succeeded", {
          progress: 1,
          total: 2,
          prUrl: "https://github.com/jinwon-int/a2a-broker/pull/901",
        }),
        eventFor("workerdelta", "succeeded", {
          progress: 2,
          total: 2,
          doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/900#issuecomment-1",
        }),
      ],
    },
    policyMode: "comment_only",
    parentRoundId: "round-437",
    parentRoundTotal: 2,
    parentRoundOrder: 1,
    hasGitHubToken: true,
    ciPassUrls: ["https://github.com/jinwon-int/a2a-broker/actions/runs/1"],
  };
}

test("dry-run returns exact target and finalizer draft without post permission", () => {
  const plan = buildAutoCloseoutPlan(buildInput(), { now: NOW });
  const draft = buildCommentOnlyCloseoutDraft(
    { plan, targetIssueUrl: TARGET, mode: "dry_run", githubPermission: "unknown" },
    { now: NOW },
  );

  assert.equal(draft.targetIssueUrl, TARGET);
  assert.equal(draft.mode, "dry_run");
  assert.equal(draft.plannedAction, "dry_run");
  assert.equal(draft.postPermitted, false);
  assert.equal(draft.safety.executesIssueClose, false);
  assert.equal(draft.safety.executesPrMerge, false);
  assert.equal(draft.safety.executesTerminalAckReplay, false);
  assert.match(draft.bodyWithMarker, /a2a:comment-only-closeout/);
  assert.match(draft.bodyWithMarker, /This is `comment_only` closeout/);
  assert.match(draft.bodyWithMarker, /https:\/\/github\.com\/jinwon-int\/a2a-nexus\/issues\/437/);
});

test("comment_only permits only an approved idempotent comment action", () => {
  const plan = buildAutoCloseoutPlan(buildInput(), { now: NOW });
  const draft = buildCommentOnlyCloseoutDraft(
    {
      plan,
      targetIssueUrl: TARGET,
      mode: "comment_only",
      githubPermission: "granted",
      operatorApproved: true,
    },
    { now: NOW },
  );

  assert.equal(draft.plannedAction, "post_comment");
  assert.equal(draft.postPermitted, true);
  assert.equal(draft.blockers.length, 0);
  assert.equal(draft.safety.commentOnly, true);
  assert.equal(draft.safety.executesDbMutation, false);
  assert.equal(draft.safety.executesRestartDeploy, false);
  assert.equal(draft.safety.executesProviderSend, false);
});

test("duplicate marker suppresses repeated comment_only posting", () => {
  const plan = buildAutoCloseoutPlan(buildInput(), { now: NOW });
  const marker = buildCommentOnlyMarker(plan.idempotencyKey);
  const draft = buildCommentOnlyCloseoutDraft(
    {
      plan,
      targetIssueUrl: TARGET,
      mode: "comment_only",
      githubPermission: "granted",
      operatorApproved: true,
      existingComments: [{ id: 10, body: marker + "\nprevious closeout" }],
    },
    { now: NOW },
  );

  assert.equal(draft.plannedAction, "skip_duplicate");
  assert.equal(draft.postPermitted, false);
  assert.equal(draft.duplicateComment?.id, 10);
  assert.ok(draft.warnings.some((warning) => warning.includes("duplicate")));
});

test("permission denial and missing operator approval block posting", () => {
  const plan = buildAutoCloseoutPlan(buildInput(), { now: NOW });
  const draft = buildCommentOnlyCloseoutDraft(
    {
      plan,
      targetIssueUrl: TARGET,
      mode: "comment_only",
      githubPermission: "denied",
      operatorApproved: false,
    },
    { now: NOW },
  );

  assert.equal(draft.plannedAction, "blocked");
  assert.equal(draft.postPermitted, false);
  assert.ok(draft.blockers.some((blocker) => blocker.includes("permission denied")));
  assert.ok(draft.blockers.some((blocker) => blocker.includes("operator approval")));
});

test("rendered markdown exposes blockers, target, and safety", () => {
  const plan = buildAutoCloseoutPlan(buildInput(), { now: NOW });
  const draft = buildCommentOnlyCloseoutDraft(
    { plan, targetIssueUrl: TARGET, mode: "comment_only", githubPermission: "denied" },
    { now: NOW },
  );
  const markdown = renderCommentOnlyCloseoutDraftMarkdown(draft);

  assert.match(markdown, /A2A Team1 closeout comment draft/);
  assert.match(markdown, /Target: https:\/\/github\.com\/jinwon-int\/a2a-nexus\/issues\/437/);
  assert.match(markdown, /GitHub comment permission denied/);
  assert.match(markdown, /executesIssueClose=false/);
  assert.match(markdown, /executesTerminalAckReplay=false/);
});

function buildInputWithMissingWorkers(): TerminalBriefAutoCloseoutPlannerInput {
  const input = buildInput();
  assert.ok(input.finalCountInput, "test fixture must include finalCountInput");
  // Remove workerdelta event so only workergamma has evidence, making workerdelta a missing worker
  input.finalCountInput.events = input.finalCountInput.events.filter(
    (e) => e.payload.worker !== "workerdelta",
  );
  return input;
}

test("missing workers block comment_only closeout with named blocker", () => {
  const plan = buildAutoCloseoutPlan(buildInputWithMissingWorkers(), { now: NOW });
  const draft = buildCommentOnlyCloseoutDraft(
    {
      plan,
      targetIssueUrl: TARGET,
      mode: "comment_only",
      githubPermission: "granted",
      operatorApproved: true,
    },
    { now: NOW },
  );

  assert.equal(draft.plannedAction, "blocked");
  assert.equal(draft.postPermitted, false);
  assert.ok(
    draft.blockers.some((b) => b.includes("missing workers") && b.includes("workerdelta")),
    "blockers should name missing workers",
  );
});

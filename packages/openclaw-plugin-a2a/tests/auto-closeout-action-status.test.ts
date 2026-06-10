/**
 * Tests for auto-closeout action status projection (#406).
 *
 * Issue:  jinwon-int/plugin-a2a#406
 * Parent: jinwon-int/a2a-broker#844
 * Run:    a2a-team1-auto-closeout-action-reconcile-20260520T180955Z
 * Round:  3/4
 * Worker: sogyo
 *
 * Covers:
 *  - All three post-action states: executed, noop, failed.
 *  - All pre-action states: draft_ready, comment_only_ready,
 *    comment_and_close_requires_approval, blocked.
 *  - Approval gating (fail-closed when approval required but not obtained).
 *  - Accepted-send-is-not-ACK semantics.
 *  - Edge cases: missing candidate evaluation, waiting→draft_ready mapping.
 *  - Terminal Brief formatting.
 *  - Categorization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectAutoCloseoutActionStatus, formatAutoCloseoutStatusForTerminalBrief, categorizeActionStatus } from "../dist/src/auto-closeout-action-status.js";
import type { A2AAutoCloseoutStatusProjection, A2AAutoCloseoutActionStatus } from "../dist/src/auto-closeout-action-status.js";
import type { A2ACloseoutCandidateEvaluation } from "../dist/src/operator-closeout-trigger.js";

// ── Clock ───────────────────────────────────────────────────────

const NOW = 1710000000000;
function fixedNow(): number {
  return NOW;
}

// ── Helper: build a minimal candidate evaluation ─────────────────

function makeCandidateEvaluation(
  state: A2ACloseoutCandidateEvaluation["state"],
): A2ACloseoutCandidateEvaluation {
  return {
    state,
    summary: `Candidate ${state}`,
    totalLanes: 3,
    completedLanes: 0,
    failedLanes: 0,
    blockedLanes: 0,
  };
}

// ── Schema & version ────────────────────────────────────────────

const EXPECTED_SCHEMA = "a2a.auto-closeout.status-projection.v1" as const;
const EXPECTED_VERSION = 1;
const PARENT_ROUND_ID = "a2a-team1-auto-closeout-action-reconcile-20260520T180955Z";
const RUN_ID = "test-run-406";

function defaultInput(overrides: Record<string, unknown> = {}) {
  return {
    parentRoundId: PARENT_ROUND_ID,
    runId: RUN_ID,
    now: fixedNow,
    ...overrides,
  };
}

// ── Common assertions ───────────────────────────────────────────

function assertCommonProjectionBasics(
  p: A2AAutoCloseoutStatusProjection,
  expectedStatus: A2AAutoCloseoutActionStatus,
): void {
  assert.equal(p.schema, EXPECTED_SCHEMA, "schema mismatch");
  assert.equal(p.version, EXPECTED_VERSION, "version mismatch");
  assert.equal(p.parentRoundId, PARENT_ROUND_ID, "parentRoundId mismatch");
  assert.equal(p.runId, RUN_ID, "runId mismatch");
  assert.equal(p.projectedAt, NOW, "projectedAt mismatch");
  assert.equal(p.status, expectedStatus, `expected status ${expectedStatus}, got ${p.status}`);
  assert.equal(p.category, categorizeActionStatus(expectedStatus), "category mismatch");

  // Non-ACK semantics must always hold
  assert.equal(p.acceptedSendIsNotAck, true, "acceptedSendIsNotAck must always be true");
  assert.equal(p.isCloseoutAck, false, "isCloseoutAck must always be false");
}

// ═══════════════════════════════════════════════════════════════════
// Post-action states
// ═══════════════════════════════════════════════════════════════════

describe("post-action: executed", () => {
  it("should project executed for comment action with evidenceUrl", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment",
        result: {
          outcome: "executed",
          action: "comment",
          evidenceUrl: "https://github.com/jinwon-int/a2a-broker/issues/844#issuecomment-1",
        },
      }),
    );

    assertCommonProjectionBasics(p, "executed");
    assert.equal(p.action, "comment");
    assert.equal(p.result?.outcome, "executed");
    assert.equal(p.result?.action, "comment");
    assert.equal(p.result?.evidenceUrl, "https://github.com/jinwon-int/a2a-broker/issues/844#issuecomment-1");
    assert.ok(p.summary.includes("CLOSEOUT EXECUTED"), "summary should say EXECUTED");
    assert.ok(p.summary.includes(p.result!.evidenceUrl!), "summary should include evidence URL");
  });

  it("should project executed for comment_and_close action without evidenceUrl", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment_and_close",
        result: { outcome: "executed", action: "comment_and_close" },
        approvalRequired: true,
        approvalObtained: true,
      }),
    );

    assertCommonProjectionBasics(p, "executed");
    assert.equal(p.action, "comment_and_close");
    assert.equal(p.approvalGated, true);
    assert.equal(p.approvalObtained, true);
    assert.ok(p.summary.includes("CLOSEOUT EXECUTED"));
  });

  it("should pass through candidate evaluation when available", () => {
    const candidate = makeCandidateEvaluation("comment_and_close_requires_approval");
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: candidate,
        action: "comment_and_close",
        result: { outcome: "executed", action: "comment_and_close" },
        approvalRequired: true,
        approvalObtained: true,
      }),
    );

    assert.equal(p.candidateEvaluation, candidate);
  });
});

describe("post-action: noop", () => {
  it("should project noop with reason", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        result: {
          outcome: "noop",
          action: "noop",
          reason: "All lanes already resolved — nothing to close out",
        },
      }),
    );

    assertCommonProjectionBasics(p, "noop");
    assert.equal(p.action, "noop");
    assert.equal(p.result?.outcome, "noop");
    assert.equal(p.result?.action, "noop");
    assert.equal(p.result?.reason, "All lanes already resolved — nothing to close out");
    assert.ok(p.summary.includes("CLOSEOUT NOOP"));
    assert.ok(p.summary.includes("All lanes already resolved"));
  });
});

describe("post-action: failed", () => {
  it("should project failed with error code and message", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment",
        result: {
          outcome: "failed",
          action: "comment",
          errorCode: "github_api_error",
          errorMessage: "GitHub API returned 422: comment body too long",
        },
      }),
    );

    assertCommonProjectionBasics(p, "failed");
    assert.equal(p.action, "comment");
    assert.equal(p.result?.outcome, "failed");
    assert.equal(p.result?.errorCode, "github_api_error");
    assert.equal(p.result?.errorMessage, "GitHub API returned 422: comment body too long");
    assert.ok(p.summary.includes("CLOSEOUT FAILED"));
    assert.ok(p.summary.includes("github_api_error"));
  });

  it("should project failed with internal_error for missing result", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment",
        result: {
          outcome: "failed",
          action: "comment",
          errorCode: "internal_error",
          errorMessage: "Unexpected error in closeout projection layer",
        },
      }),
    );

    assertCommonProjectionBasics(p, "failed");
    assert.equal(p.result?.errorCode, "internal_error");
  });

  it("should project failed with target_not_found", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment_and_close",
        result: {
          outcome: "failed",
          action: "comment_and_close",
          errorCode: "target_not_found",
          errorMessage: "Issue #9999 not found in repo",
        },
      }),
    );

    assertCommonProjectionBasics(p, "failed");
    assert.equal(p.result?.errorCode, "target_not_found");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Pre-action (candidate evaluation) states
// ═══════════════════════════════════════════════════════════════════

describe("pre-action: draft_ready", () => {
  it("should project draft_ready from candidate evaluation", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("draft_ready"),
      }),
    );

    assertCommonProjectionBasics(p, "draft_ready");
    assert.equal(p.category, "pre_action");
    assert.ok(p.summary.includes("DRAFT READY"));
  });

  it("should project draft_ready when candidate state is waiting (mapped)", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("waiting"),
      }),
    );

    assertCommonProjectionBasics(p, "draft_ready");
    assert.ok(p.summary.includes("DRAFT READY"));
  });

  it("should project draft_ready when no candidate evaluation", () => {
    const p = projectAutoCloseoutActionStatus(defaultInput());

    assertCommonProjectionBasics(p, "draft_ready");
    assert.equal(p.candidateEvaluation, undefined);
  });
});

describe("pre-action: comment_only_ready", () => {
  it("should project comment_only_ready from candidate evaluation", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("comment_only_ready"),
      }),
    );

    assertCommonProjectionBasics(p, "comment_only_ready");
    assert.equal(p.category, "pre_action");
    assert.ok(p.summary.includes("COMMENT ONLY READY"));
  });
});

describe("pre-action: comment_and_close_requires_approval", () => {
  it("should project requires approval from candidate evaluation", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("comment_and_close_requires_approval"),
      }),
    );

    assertCommonProjectionBasics(p, "comment_and_close_requires_approval");
    assert.equal(p.category, "pre_action");
    assert.ok(
      p.summary.includes("REQUIRES APPROVAL"),
      `expected summary to mention REQUIRES APPROVAL; got: ${p.summary}`,
    );
  });
});

describe("pre-action: blocked", () => {
  it("should project blocked from candidate evaluation", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("blocked"),
      }),
    );

    assertCommonProjectionBasics(p, "blocked");
    assert.equal(p.category, "blocked");
    assert.ok(p.summary.includes("BLOCKED"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Approval gating (fail-closed)
// ═══════════════════════════════════════════════════════════════════

describe("approval gating — fail-closed", () => {
  it("should block comment_and_close when approval required but not obtained", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment_and_close",
        approvalRequired: true,
        approvalObtained: false,
      }),
    );

    assertCommonProjectionBasics(p, "blocked");
    assert.equal(p.category, "blocked");
    assert.equal(p.approvalGated, true);
    assert.equal(p.approvalObtained, false);
    assert.equal(p.result?.outcome, "failed");
    assert.equal(p.result?.errorCode, "approval_required");
    assert.ok(p.summary.includes("CLOSEOUT BLOCKED (approval gate)"));
    assert.ok(
      p.summary.includes("requires operator approval"),
      `expected summary to mention requires operator approval; got: ${p.summary}`,
    );
  });

  it("should block comment_and_close when approvalRequired is true but not passed", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment_and_close",
        approvalRequired: true,
        // approvalObtained not set → undefined ≠ true → blocked
      }),
    );

    assertCommonProjectionBasics(p, "blocked");
    assert.equal(p.approvalGated, true);
    assert.equal(p.approvalObtained, false);
  });

  it("should NOT block comment action when approval not obtained", () => {
    // comment-only actions don't require close approval
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("comment_only_ready"),
        action: "comment",
        approvalRequired: false,
        approvalObtained: false,
      }),
    );

    assertCommonProjectionBasics(p, "comment_only_ready");
    assert.equal(p.approvalGated, false);
    assert.equal(p.approvalObtained, false);
  });

  it("should allow comment_and_close with approval obtained", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment_and_close",
        result: { outcome: "executed", action: "comment_and_close" },
        approvalRequired: true,
        approvalObtained: true,
      }),
    );

    assertCommonProjectionBasics(p, "executed");
    assert.equal(p.approvalGated, true);
    assert.equal(p.approvalObtained, true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Non-ACK semantics
// ═══════════════════════════════════════════════════════════════════

describe("non-ACK semantics", () => {
  it("acceptedSendIsNotAck is always true for executed states", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        result: { outcome: "executed", action: "comment", evidenceUrl: "https://example.com/1" },
      }),
    );
    assert.equal(p.acceptedSendIsNotAck, true);
    assert.equal(p.isCloseoutAck, false);
  });

  it("acceptedSendIsNotAck is always true for failed states", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        result: {
          outcome: "failed",
          action: "comment",
          errorCode: "github_api_error",
          errorMessage: "error",
        },
      }),
    );
    assert.equal(p.acceptedSendIsNotAck, true);
    assert.equal(p.isCloseoutAck, false);
  });

  it("acceptedSendIsNotAck is always true for pre-action states", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("draft_ready"),
      }),
    );
    assert.equal(p.acceptedSendIsNotAck, true);
    assert.equal(p.isCloseoutAck, false);
  });

  it("acceptedSendIsNotAck is always true for noop states", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        result: { outcome: "noop", action: "noop", reason: "nothing to do" },
      }),
    );
    assert.equal(p.acceptedSendIsNotAck, true);
    assert.equal(p.isCloseoutAck, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Terminal Brief formatting
// ═══════════════════════════════════════════════════════════════════

describe("Terminal Brief formatting", () => {
  it("should format executed status", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment",
        result: { outcome: "executed", action: "comment" },
        approvalRequired: true,
        approvalObtained: true,
      }),
    );
    const line = formatAutoCloseoutStatusForTerminalBrief(p);
    assert.ok(line.includes("EXECUTED"), "label should be EXECUTED");
    assert.ok(line.includes(PARENT_ROUND_ID), "should include round ID");
    assert.ok(line.includes("non-ACK"), "should include non-ACK marker");
    assert.ok(line.includes("approved"), "should include approved marker");
  });

  it("should format noop status", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        result: { outcome: "noop", action: "noop", reason: "nothing to do" },
      }),
    );
    const line = formatAutoCloseoutStatusForTerminalBrief(p);
    assert.ok(line.includes("NO-OP"), "label should be NO-OP");
    assert.ok(line.includes("non-ACK"), "should include non-ACK marker");
  });

  it("should format draft_ready status", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        candidateEvaluation: makeCandidateEvaluation("draft_ready"),
      }),
    );
    const line = formatAutoCloseoutStatusForTerminalBrief(p);
    assert.ok(line.includes("DRAFT READY"), "label should be DRAFT READY");
  });

  it("should format blocked status with pending-approval marker", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment_and_close",
        approvalRequired: true,
        approvalObtained: false,
      }),
    );
    const line = formatAutoCloseoutStatusForTerminalBrief(p);
    assert.ok(line.includes("BLOCKED"), "label should be BLOCKED");
    assert.ok(line.includes("pending-approval"), "should include pending-approval marker");
  });

  it("should format failed status", () => {
    const p = projectAutoCloseoutActionStatus(
      defaultInput({
        action: "comment",
        result: {
          outcome: "failed",
          action: "comment",
          errorCode: "target_not_found",
          errorMessage: "target missing",
        },
      }),
    );
    const line = formatAutoCloseoutStatusForTerminalBrief(p);
    assert.ok(line.includes("FAILED"), "label should be FAILED");
    assert.ok(line.includes("non-ACK"), "should include non-ACK marker");
  });
});

// ═══════════════════════════════════════════════════════════════════
// categorizeActionStatus
// ═══════════════════════════════════════════════════════════════════

describe("categorizeActionStatus", () => {
  it("should categorize pre-action states", () => {
    assert.equal(categorizeActionStatus("draft_ready"), "pre_action");
    assert.equal(categorizeActionStatus("comment_only_ready"), "pre_action");
    assert.equal(categorizeActionStatus("comment_and_close_requires_approval"), "pre_action");
  });

  it("should categorize action_complete states", () => {
    assert.equal(categorizeActionStatus("executed"), "action_complete");
    assert.equal(categorizeActionStatus("noop"), "action_complete");
  });

  it("should categorize action_failed", () => {
    assert.equal(categorizeActionStatus("failed"), "action_failed");
  });

  it("should categorize blocked", () => {
    assert.equal(categorizeActionStatus("blocked"), "blocked");
  });
});

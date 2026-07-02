/**
 * Operator closeout-trigger metadata contract tests (#399, #404).
 *
 * Extended in #404 for auto-closeout dry-run candidate/status with states:
 * waiting, blocked, draft_ready, comment_only_ready, comment_and_close_requires_approval.
 *
 * All operations are pure projections — no live provider send, no terminal ACK,
 * no Gateway restart, no read/visibility/terminal ACK semantics.
 * Provider accepted/message-id evidence is accepted-send only.
 *
 * Issue:  jinwon-int/plugin-a2a#404
 * Parent: jinwon-int/a2a-broker#841
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA,
  A2A_CLOSEOUT_TITLE_RULE,
  evaluateA2AOperatorCloseoutCandidate,
  extractA2AOperatorCloseoutTriggerMetadata,
} from "../dist/src/operator-closeout-trigger.js";
import type {
  A2AOperatorCloseoutTriggerMetadata,
  A2ACloseoutCandidateInput,
} from "../dist/src/operator-closeout-trigger.js";
import type { A2AOperatorTerminalNotificationEnvelope } from "../dist/src/operator-terminal-notifier.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeEnvelope(
  overrides: Partial<A2AOperatorTerminalNotificationEnvelope> &
    Pick<
      A2AOperatorTerminalNotificationEnvelope,
      "parentRoundId" | "parentRoundTotal" | "parentRoundOrder"
    >,
): A2AOperatorTerminalNotificationEnvelope {
  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: `notify-${overrides.parentRoundOrder}`,
    dedupeKey: `dedup:${overrides.parentRoundOrder}:${overrides.parentRoundId}`,
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A Terminal Brief 완료",
    text: "",
    evidence: {
      schema: "a2a.operator.notification.evidence",
      version: 1,
    },
    ...overrides,
  } as A2AOperatorTerminalNotificationEnvelope;
}

// ── Schema / Constants ─────────────────────────────────────────────

describe("A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA", () => {
  it("is a stable schema identifier", () => {
    assert.equal(
      A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA,
      "a2a.operator.closeout-trigger.v1",
    );
  });
});

describe("A2A_CLOSEOUT_TITLE_RULE", () => {
  it("enforces completed_progress as the title numerator source", () => {
    assert.equal(A2A_CLOSEOUT_TITLE_RULE.numeratorSource, "completed_progress");
    assert.equal(A2A_CLOSEOUT_TITLE_RULE.laneOrderInTitleIsBreach, true);
  });

  it("enumerates the title/body fields that must be exposed in final N/N", () => {
    assert.ok(Array.isArray(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("terminalCount"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("successCount"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("laneOrder"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("parentRoundId"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("parentRoundTotal"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("originBrokerId"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("brokerOfRecordId"));
    assert.ok(A2A_CLOSEOUT_TITLE_RULE.titleBodyFields.includes("outboxTime"));
  });
});

// ── Extraction ─────────────────────────────────────────────────────

describe("extractA2AOperatorCloseoutTriggerMetadata", () => {
  it("extracts metadata from a minimal parent-round envelope", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-design-001",
      parentRoundTotal: 4,
      parentRoundOrder: 3,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta, "expected metadata");

    assert.equal(meta.schema, A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA);
    assert.equal(meta.version, 1);
    assert.equal(meta.parentRoundId, "round-design-001");
    assert.equal(meta.parentRoundTotal, 4);
    assert.equal(meta.laneOrder, 3);
    assert.equal(meta.dedupeKey, envelope.dedupeKey);
    assert.equal(meta.receiptRule, "not_ack_evidence");
  });

  it("reports success count for success-type notifications", () => {
    const envelope = makeEnvelope({
      type: "success",
      parentRoundId: "round-design-002",
      parentRoundTotal: 2,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);
    assert.equal(meta.successCount, 1);
    assert.equal(meta.terminalCount, 1);
  });

  it("reports success=0 for failure-type notifications", () => {
    const envelope = makeEnvelope({
      type: "failure",
      parentRoundId: "round-design-003",
      parentRoundTotal: 2,
      parentRoundOrder: 2,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);
    assert.equal(meta.successCount, 0);
  });

  it("reports success=0 for block-type notifications", () => {
    const envelope = makeEnvelope({
      type: "block",
      parentRoundId: "round-design-004",
      parentRoundTotal: 2,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);
    assert.equal(meta.successCount, 0);
  });

  it("reports success=1 for pr-type notifications", () => {
    const envelope = makeEnvelope({
      type: "pr",
      parentRoundId: "round-design-005",
      parentRoundTotal: 1,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);
    assert.equal(meta.successCount, 1);
  });

  it("accepts broker IDs from context override", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-design-006",
      parentRoundTotal: 4,
      parentRoundOrder: 2,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope, {
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
    });
    assert.ok(meta);
    assert.equal(meta.originBrokerId, "brokerAlpha");
    assert.equal(meta.brokerOfRecordId, "brokerAlpha");
  });

  it("falls back to unknown when no broker context", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-design-007",
      parentRoundTotal: 1,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);
    assert.equal(meta.originBrokerId, "unknown");
    assert.equal(meta.brokerOfRecordId, "unknown");
  });

  it("returns undefined when envelope has no parentRoundId", () => {
    const envelope = makeEnvelope({
      parentRoundId: undefined as unknown as string,
      parentRoundTotal: 4,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.equal(meta, undefined);
  });

  it("returns undefined when envelope has no parentRoundTotal", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-design-009",
      parentRoundTotal: undefined as unknown as number,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.equal(meta, undefined);
  });

  it("returns undefined when envelope has no parentRoundOrder", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-design-010",
      parentRoundTotal: 4,
      parentRoundOrder: undefined as unknown as number,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.equal(meta, undefined);
  });

  it("accepts terminalCount from context", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-design-011",
      parentRoundTotal: 4,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope, {
      terminalCount: 3, // Context reports 3 terminals observed so far.
    });
    assert.ok(meta);
    assert.equal(meta.terminalCount, 3);
  });

  // ── #404 extensions ──────────────────────────────────────────────

  it("includes outboxTime when provided in context (#404)", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-outbox-001",
      parentRoundTotal: 4,
      parentRoundOrder: 1,
    });

    const ts = "2025-05-20T17:43:11Z";
    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope, {
      outboxTime: ts,
    });
    assert.ok(meta);
    assert.equal(meta.outboxTime, ts);
  });

  it("omits outboxTime when not provided in context (#404)", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-outbox-002",
      parentRoundTotal: 4,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);
    assert.equal(meta.outboxTime, undefined);
  });
});

// ── Candidate evaluation (#404 extended states) ────────────────────

describe("evaluateA2AOperatorCloseoutCandidate (#404)", () => {
  it("returns draft_ready when all lanes observed, no blocks, no draft/comment context", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-draft-001",
      parentRoundTotal: 3,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
        { type: "success", laneOrder: 3, dedupeKey: "dedup:3", operatorNotificationId: "notify-3" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "draft_ready");
    assert.equal(result.observedCount, 3);
    assert.equal(result.successCount, 3);
    assert.equal(result.blockedCount, 0);
    assert.equal(result.waitingCount, 0);
    assert.ok(result.summary.includes("CLOSEOUT DRAFT READY"));
  });

  it("returns comment_only_ready when draftPrepared is true", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-comment-only-001",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      draftPrepared: true,
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "comment_only_ready");
    assert.ok(result.summary.includes("CLOSEOUT COMMENT READY"));
  });

  it("returns comment_only_ready when commentPosted is true (no close approval needed)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-comment-only-002",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      commentPosted: true,
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "comment_only_ready");
  });

  it("returns comment_and_close_requires_approval when commentPosted + requiresApprovalBeforeClose", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-approval-001",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      commentPosted: true,
      requiresApprovalBeforeClose: true,
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "comment_and_close_requires_approval");
    assert.ok(result.summary.includes("CLOSEOUT APPROVAL REQUIRED"));
  });

  it("returns blocked when any observation is failure (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-blocked-001",
      parentRoundTotal: 3,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "failure", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
        { type: "success", laneOrder: 3, dedupeKey: "dedup:3", operatorNotificationId: "notify-3" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "blocked");
    assert.equal(result.blockedCount, 1);
    assert.equal(result.successCount, 2);
    assert.ok(result.summary.includes("CLOSEOUT BLOCKED"));
  });

  it("returns blocked when any observation is block type (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-blocked-002",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "block", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "blocked");
    assert.equal(result.blockedCount, 1);
    assert.ok(result.summary.includes("CLOSEOUT BLOCKED"));
  });

  it("returns waiting when lanes are still outstanding (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-waiting-001",
      parentRoundTotal: 4,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 3, dedupeKey: "dedup:3", operatorNotificationId: "notify-3" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "waiting");
    assert.equal(result.observedCount, 2);
    assert.equal(result.waitingCount, 2);
    assert.equal(result.successCount, 2);
    assert.ok(result.summary.includes("CLOSEOUT WAITING"));
  });

  it("deduplicates observations by dedupeKey (stable idempotency) (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-dedup-001",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
        // Duplicate: same dedupeKey as lane 2, different notification id.
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2-b" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.observedCount, 2);
    assert.equal(result.successCount, 2);
    assert.equal(result.state, "draft_ready");
  });

  it("handles out-of-order delivery with stable dedup key (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-outoforder-001",
      parentRoundTotal: 3,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        // Lane 3 arrives before lane 1.
        { type: "success", laneOrder: 3, dedupeKey: "dedup:3", operatorNotificationId: "notify-3" },
        // Lane 3 duplicate (re-delivered out of order).
        { type: "success", laneOrder: 3, dedupeKey: "dedup:3", operatorNotificationId: "notify-3-b" },
        // Lane 1 arrives late.
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.observedCount, 2);
    assert.equal(result.state, "waiting");
  });

  it("transitions from waiting through draft_ready to comment_only_ready (#404)", () => {
    // Step 1: single lane observed → waiting.
    const step1: A2ACloseoutCandidateInput = {
      parentRoundId: "round-step-001",
      parentRoundTotal: 4,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
      ],
    };
    assert.equal(evaluateA2AOperatorCloseoutCandidate(step1).state, "waiting");

    // Step 2: all 4 lanes observed → draft_ready (no context flags).
    const step2: A2ACloseoutCandidateInput = {
      parentRoundId: "round-step-001",
      parentRoundTotal: 4,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
        { type: "success", laneOrder: 3, dedupeKey: "dedup:3", operatorNotificationId: "notify-3" },
        { type: "success", laneOrder: 4, dedupeKey: "dedup:4", operatorNotificationId: "notify-4" },
      ],
    };
    assert.equal(evaluateA2AOperatorCloseoutCandidate(step2).state, "draft_ready");

    // Step 3: draft prepared → comment_only_ready.
    const step3: A2ACloseoutCandidateInput = { ...step2, draftPrepared: true };
    assert.equal(evaluateA2AOperatorCloseoutCandidate(step3).state, "comment_only_ready");
  });

  it("counts pr-type as success (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-pr-001",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "pr", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:2", operatorNotificationId: "notify-2" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "draft_ready");
    assert.equal(result.successCount, 2);
  });

  it("handles empty observations (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-empty-001",
      parentRoundTotal: 4,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.state, "waiting");
    assert.equal(result.observedCount, 0);
    assert.equal(result.waitingCount, 4);
  });

  it("rejects duplicate dedupeKey even if different operatorNotificationId (#404)", () => {
    const input: A2ACloseoutCandidateInput = {
      parentRoundId: "round-dupe-id-001",
      parentRoundTotal: 2,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [
        { type: "success", laneOrder: 1, dedupeKey: "dedup:lane1", operatorNotificationId: "notify-1-original" },
        // Replay with same dedupeKey but different notification id.
        { type: "success", laneOrder: 1, dedupeKey: "dedup:lane1", operatorNotificationId: "notify-1-replay" },
        { type: "success", laneOrder: 2, dedupeKey: "dedup:lane2", operatorNotificationId: "notify-2" },
      ],
    };

    const result = evaluateA2AOperatorCloseoutCandidate(input);
    assert.equal(result.observedCount, 2);
    assert.equal(result.state, "draft_ready");
  });
});

// ── Non-ACK semantics (#404) ────────────────────────────────────────

describe("Non-ACK semantics (#404)", () => {
  it("receiptRule is always not_ack_evidence for all notification types", () => {
    for (const notificationType of ["success", "failure", "block", "pr"] as const) {
      const envelope = makeEnvelope({
        type: notificationType,
        parentRoundId: "round-receipt-001",
        parentRoundTotal: 2,
        parentRoundOrder: 1,
      });

      const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
      assert.ok(meta);
      assert.equal(meta.receiptRule, "not_ack_evidence",
        `receiptRule must be not_ack_evidence for type: ${notificationType}`);
    }
  });

  it("provider accepted/message-id fields are never read/visibility/terminal ACK evidence", () => {
    // The envelope does not carry any provider-accepted or message-id fields
    // for read/visibility/ACK semantics. This test asserts that the
    // operator-closeout-trigger metadata exposes no such fields.
    const envelope = makeEnvelope({
      parentRoundId: "round-nonack-001",
      parentRoundTotal: 2,
      parentRoundOrder: 1,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);

    // The metadata type must NOT carry provider-read, provider-visible,
    // or terminal-ACK fields.
    const keys = Object.keys(meta) as Array<keyof typeof meta>;
    const ackLike = keys.filter(
      (k) =>
        k.toLowerCase().includes("read") ||
        k.toLowerCase().includes("visibility") ||
        k.toLowerCase().includes("terminal_ack") ||
        k.toLowerCase().includes("provider_ack"),
    );
    assert.equal(ackLike.length, 0,
      `metadata must not contain ACK-like fields, found: ${ackLike.join(", ")}`);
  });
});

// ── Contract integrity (#404) ──────────────────────────────────────

describe("Closeout-trigger contract integrity (#404)", () => {
  it("extracted metadata satisfies the A2AOperatorCloseoutTriggerMetadata type", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-integrity-001",
      parentRoundTotal: 3,
      parentRoundOrder: 2,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope, {
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
    });
    assert.ok(meta);

    // Verify all required fields (non-optional) exist and have correct types.
    const required: (keyof A2AOperatorCloseoutTriggerMetadata)[] = [
      "schema",
      "version",
      "parentRoundId",
      "parentRoundTotal",
      "terminalCount",
      "successCount",
      "laneOrder",
      "originBrokerId",
      "brokerOfRecordId",
      "operatorNotificationId",
      "dedupeKey",
      "receiptRule",
    ];
    for (const field of required) {
      assert.ok(
        field in (meta as Record<string, unknown>),
        `missing required field: ${field}`,
      );
    }
  });

  it("extracted metadata values are within expected bounds", () => {
    const envelope = makeEnvelope({
      parentRoundId: "round-bounds-001",
      parentRoundTotal: 4,
      parentRoundOrder: 3,
    });

    const meta = extractA2AOperatorCloseoutTriggerMetadata(envelope);
    assert.ok(meta);

    assert.ok(meta.laneOrder >= 1, "laneOrder must be >= 1");
    assert.ok(
      meta.laneOrder <= meta.parentRoundTotal,
      "laneOrder must not exceed parentRoundTotal",
    );
    assert.ok(meta.terminalCount >= 1, "terminalCount must be >= 1");
    assert.ok(
      meta.successCount === 0 || meta.successCount === 1,
      "successCount must be 0 or 1 for single notification",
    );
  });

  it("enumerates all five candidate states in the type (#404)", () => {
    // The type must accept all five states; we test each via the evaluation.
    const states: string[] = [];
    const base: A2ACloseoutCandidateInput = {
      parentRoundId: "round-states-001",
      parentRoundTotal: 1,
      originBrokerId: "brokerAlpha",
      brokerOfRecordId: "brokerAlpha",
      observations: [{ type: "success", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" }],
    };

    // waiting
    const emptyObs = evaluateA2AOperatorCloseoutCandidate({ ...base, observations: [] });
    states.push(emptyObs.state);

    // blocked
    const blockObs = evaluateA2AOperatorCloseoutCandidate({
      ...base,
      observations: [{ type: "failure", laneOrder: 1, dedupeKey: "dedup:1", operatorNotificationId: "notify-1" }],
    });
    states.push(blockObs.state);

    // draft_ready
    const draftObs = evaluateA2AOperatorCloseoutCandidate(base);
    states.push(draftObs.state);

    // comment_only_ready
    const commentObs = evaluateA2AOperatorCloseoutCandidate({ ...base, draftPrepared: true });
    states.push(commentObs.state);

    // comment_and_close_requires_approval
    const approvalObs = evaluateA2AOperatorCloseoutCandidate({
      ...base,
      commentPosted: true,
      requiresApprovalBeforeClose: true,
    });
    states.push(approvalObs.state);

    assert.deepEqual([...new Set(states)].sort(), [
      "blocked",
      "comment_and_close_requires_approval",
      "comment_only_ready",
      "draft_ready",
      "waiting",
    ]);
  });
});

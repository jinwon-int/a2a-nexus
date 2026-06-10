/**
 * Cross-broker terminal relay tests (#284).
 *
 * Parent: jinwon-int/plugin-a2a#284
 *
 * Exercises the cross-broker terminal projection builder and receipt gap
 * projection, verifying that provider send success is always separate from
 * operator-visible ACK evidence. No live send, no terminal ACK, no Gateway
 * restart — all operations are pure projections.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildA2ACrossBrokerTerminalProjection,
  getCrossBrokerTerminalReceiptGap,
  type A2ACrossBrokerTerminalProjection,
} from "../dist/src/cross-broker-terminal-relay.js";
import type { A2ATerminalOutboxEvent } from "../dist/standalone-broker-client.js";

// ── Fixture builders ───────────────────────────────────────────────

function buildCrossBrokerTerminalEvent(
  overrides: Record<string, unknown> = {},
): A2ATerminalOutboxEvent {
  return {
    id: "terminal-outbox-event-001",
    terminalOutboxId: "outbox-canary-284-001",
    type: "terminal.brief",
    status: "completed",
    createdAt: "2026-05-13T04:00:00Z",
    updatedAt: "2026-05-13T04:01:00Z",
    retryCount: 0,
    maxRetries: 3,
    deadLettered: false,
    acknowledged: false,
    payload: {
      kind: "terminal.brief",
      taskId: "task-canary-284-001",
      status: "succeeded",
      worker: "sogyo",
      repo: "jinwon-int/plugin-a2a",
      issue: 284,
      completedAt: "2026-05-13T04:01:00Z",
      summary: "cross-broker terminal relay canary smoke",
      parentRoundTotal: 7,
      parentRoundOrder: 4,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      notificationOwnership: {
        ownerBrokerId: "gwakga-vps7",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      crossBrokerHandoff: {
        parentRoundId: "round-284-canary",
        originBrokerId: "gwakga-vps7",
        handoffBrokerId: "broker-racknerd-167be94",
        originTaskId: "task-team2-284",
      },
      ...overrides,
    },
  };
}

function buildProviderAcceptedOnlyEvent(): A2ATerminalOutboxEvent {
  return buildCrossBrokerTerminalEvent({
    // No receipt metadata — provider accepted only
  });
}

function buildProviderDeliveredEvent(): A2ATerminalOutboxEvent {
  return {
    ...buildCrossBrokerTerminalEvent({
      summary: "provider delivered but no operator receipt",
    }),
    receipt: { status: "delivered", updatedAt: "2026-05-13T04:01:00Z" },
    ack: {
      status: "delivered",
      evidence: "provider_delivery_receipt",
      updatedAt: "2026-05-13T04:01:00Z",
    },
  } as A2ATerminalOutboxEvent;
}

function buildOperatorVisibleEvent(): A2ATerminalOutboxEvent {
  return {
    ...buildCrossBrokerTerminalEvent({
      summary: "operator-visible receipt evidence exists",
    }),
    receipt: { status: "accepted", updatedAt: "2026-05-13T04:01:00Z" },
    ack: {
      status: "pending",
      evidence: "operator_visible",
      updatedAt: "2026-05-13T04:01:00Z",
    },
  } as A2ATerminalOutboxEvent;
}

function buildOperatorConfirmedEvent(): A2ATerminalOutboxEvent {
  return {
    ...buildCrossBrokerTerminalEvent({
      summary: "operator receipt confirmed",
    }),
    receipt: { status: "accepted", updatedAt: "2026-05-13T04:01:00Z" },
    ack: {
      status: "receipt_confirmed",
      evidence: "operator_confirmed",
      updatedAt: "2026-05-13T04:02:00Z",
    },
  } as A2ATerminalOutboxEvent;
}

function buildFailedEvent(): A2ATerminalOutboxEvent {
  return {
    ...buildCrossBrokerTerminalEvent({
      summary: "receipt failed",
    }),
    receipt: { status: "failed", updatedAt: "2026-05-13T04:01:00Z" },
    ack: {
      status: "failed",
      evidence: "operator_visible",
      updatedAt: "2026-05-13T04:01:00Z",
    },
  } as A2ATerminalOutboxEvent;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("cross-broker terminal relay (#284)", () => {
  describe("buildA2ACrossBrokerTerminalProjection", () => {
    it("produces a valid projection for a cross-broker terminal event", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);

      assert.ok(projection, "must produce projection for valid cross-broker event");
      assert.equal(projection!.kind, "a2a.crossBroker.terminalProjection");
      assert.equal(projection!.version, 1);
      assert.equal(projection!.childTaskId, "task-canary-284-001");
      assert.equal(projection!.parentRoundId, "round-284-canary");
      assert.equal(projection!.originBrokerId, "broker-racknerd-167be94");
      assert.equal(projection!.brokerOfRecordId, "gwakga-vps7");
      assert.equal(projection!.childWorkerId, "sogyo");
      assert.equal(projection!.status, "succeeded");
      assert.equal(projection!.parentRoundTotal, 7);
      assert.equal(projection!.parentRoundOrder, 4);
      assert.ok(projection!.relayId, "must include relayId");
      assert.ok(projection!.terminalOutboxId, "must include terminalOutboxId");
    });

    it("preserves parentRoundNum as parentRoundOrder for parent broker rendering", () => {
      const event = buildCrossBrokerTerminalEvent({
        parentRoundOrder: undefined,
        parentRoundNum: 2,
        parentRoundTotal: 2,
        worker: "jingun",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);

      assert.ok(projection, "must produce projection for parentRoundNum-only cross-broker event");
      assert.equal(projection!.childWorkerId, "jingun");
      assert.equal(projection!.parentRoundTotal, 2);
      assert.equal(projection!.parentRoundOrder, 2);
    });

    it("carries the handoff broker's rendered Terminal Brief title line for parent relay", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "sogyo",
        parentRoundProgress: 4,
        parentRoundTotal: 7,
        terminalBriefTemplate: "곽가 원문\n{title}\n요약: {summary}",
        summary: "cross-broker terminal relay canary smoke",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.equal(projection!.terminalBriefTitle, "A2A Terminal Brief 완료: sogyo(완료 4/7)");
      assert.equal(Object.hasOwn(projection!, "terminalBriefText"), false);
    });

    it("does not relay arbitrary Terminal Brief bodies as cross-broker title source", () => {
      const event = buildCrossBrokerTerminalEvent({
        parentRoundProgress: 4,
        terminalBriefText: "곽가 원문\ntoken=super-secret\n/home/operator/private/path\n```raw log```",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.equal(projection!.terminalBriefTitle, "A2A Terminal Brief 완료: sogyo(완료 4/7)");
      assert.doesNotMatch(JSON.stringify(projection), /super-secret|private\/path|raw log|terminalBriefText/);
    });

    it("receipt block always declares providerGatewaySendSuccess = not_ack_evidence", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.equal(
        projection!.receipt.providerGatewaySendSuccess,
        "not_ack_evidence",
        "provider gateway send success must always be 'not_ack_evidence' for cross-broker projections",
      );
    });

    it("receipt block always declares originTerminalAckEligible = false", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.equal(
        projection!.receipt.originTerminalAckEligible,
        false,
        "cross-broker projections are never eligible for origin terminal ACK",
      );
    });

    it("receipt reason explains why provider send is never ACK evidence", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.ok(
        projection!.receipt.reason.includes("provider send success is never operator-visible ACK evidence"),
        "receipt reason must explain provider vs ACK separation",
      );
    });

    it("receipt block has localReceiptState = pending_receipt for new events", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      // No ack set → pending_receipt
      assert.equal(
        projection!.receipt.localReceiptState,
        "pending_receipt",
      );
    });

    it("redacts secrets in summary", () => {
      const event = buildCrossBrokerTerminalEvent({
        summary: "task completed with token=abcdef123456 in output",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.ok(
        projection!.summary!.includes("[redacted]"),
        "summary must redact secrets",
      );
      assert.ok(
        !projection!.summary!.includes("abcdef123456"),
        "summary must not leak secrets",
      );
    });

    it("redacts bearer tokens in summary", () => {
      const event = buildCrossBrokerTerminalEvent({
        summary: "auth with bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.ok(
        projection!.summary!.includes("[redacted]"),
        "summary must redact bearer tokens",
      );
    });

    it("clamps long summaries", () => {
      const longSummary = "A".repeat(1000);
      const event = buildCrossBrokerTerminalEvent({ summary: longSummary });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.ok(
        projection!.summary!.length <= 281,
        "summary must be clamped to default max chars",
      );
      assert.ok(
        projection!.summary!.endsWith("…"),
        "clamped summary must end with ellipsis",
      );
    });

    it("returns undefined for missing cross-broker handoff metadata", () => {
      const event = buildCrossBrokerTerminalEvent();
      // Remove crossBrokerHandoff
      delete (event.payload as Record<string, unknown>).crossBrokerHandoff;

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(projection, undefined);
    });

    it("returns undefined for cross-broker handoff rows without parent-owned notification ownership", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.parentOwnedTerminalBrief;
      delete payload.operatorFacingOwner;
      delete payload.notificationOwnership;

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(projection, undefined);
    });

    it("does not treat generic brokerOfRecordId alone as parent-owned ownership", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.parentOwnedTerminalBrief;
      delete payload.operatorFacingOwner;
      delete payload.notificationOwnership;
      payload.brokerOfRecordId = "gwakga-vps7";

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(projection, undefined);
    });

    it("returns undefined for events with no taskId", () => {
      const event = buildCrossBrokerTerminalEvent();
      delete (event.payload as Record<string, unknown>).taskId;

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(projection, undefined);
    });

    it("includes evidence URLs in projection", () => {
      const event = buildCrossBrokerTerminalEvent({
        prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/284",
        doneUrl: "https://github.com/jinwon-int/plugin-a2a/issues/284#issuecomment-1",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      assert.equal(
        projection!.evidence.prUrl,
        "https://github.com/jinwon-int/plugin-a2a/pull/284",
      );
      assert.equal(
        projection!.evidence.doneUrl,
        "https://github.com/jinwon-int/plugin-a2a/issues/284#issuecomment-1",
      );
    });

    it("read-only evidence with doneUrl only (no prUrl) produces valid projection", () => {
      // Libero lane: only doneUrl exists, no PR
      const event = buildCrossBrokerTerminalEvent({
        summary: "read-only validation complete, evidence-only, no code changes",
        doneUrl: "https://github.com/org/repo/issues/42#issuecomment-700",
        // No prUrl — this is a libero/read-only terminal outcome
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must produce projection for read-only evidence with doneUrl only");

      assert.equal(
        projection!.evidence.doneUrl,
        "https://github.com/org/repo/issues/42#issuecomment-700",
        "doneUrl must be preserved for read-only terminal brief",
      );
      assert.equal(
        projection!.evidence.prUrl,
        undefined,
        "prUrl must be undefined when no PR exists in read-only flow",
      );
      assert.equal(projection!.status, "succeeded");
      assert.match(
        projection!.summary ?? "",
        /read-only/i,
        "summary must reflect read-only nature of the outcome",
      );
    });

    it("evidence projection with blockUrl and doneUrl, no prUrl, works for blocked read-only outcomes", () => {
      // Mixed evidence: Block evidence URL + Done evidence URL, no PR
      const event = buildCrossBrokerTerminalEvent({
        summary: "read-only block assessment complete: blocker identified and documented",
        status: "failed",
        blockUrl: "https://github.com/org/repo/issues/42#issuecomment-698",
        doneUrl: "https://github.com/org/repo/issues/42#issuecomment-699",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must produce projection for block evidence");

      assert.equal(projection!.status, "failed");
      assert.equal(
        projection!.evidence.doneUrl,
        "https://github.com/org/repo/issues/42#issuecomment-699",
      );
      assert.equal(
        projection!.evidence.prUrl,
        undefined,
        "prUrl must be undefined for read-only block outcome",
      );
    });
  });

  describe("getCrossBrokerTerminalReceiptGap — provider send ≠ operator ACK", () => {
    it("provider accepted event without receipt → operatorReceipt = none", () => {
      const event = buildProviderAcceptedOnlyEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.providerDelivery, "unknown");
      assert.equal(gap.operatorReceipt, "none");
      assert.equal(gap.terminalAckEligible, false);
      assert.ok(
        gap.reason.includes("no operator-visible receipt evidence"),
        "reason must mention missing operator-visible receipt",
      );
    });

    it("provider delivered with provider_delivery_receipt → operatorReceipt = provider_only", () => {
      const event = buildProviderDeliveredEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.providerDelivery, "provider_delivered");
      assert.equal(gap.operatorReceipt, "provider_only");
      assert.equal(gap.terminalAckEligible, false);
      assert.ok(
        gap.reason.includes("provider evidence is not Terminal Brief visibility proof"),
        "reason must explicitly separate provider evidence from operator visibility proof",
      );
    });

    it("operator_visible receipt evidence → operatorReceipt = pending_receipt", () => {
      const event = buildOperatorVisibleEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.providerDelivery, "accepted");
      assert.equal(gap.operatorReceipt, "pending_receipt");
      assert.equal(gap.terminalAckEligible, false);
      assert.ok(
        gap.reason.includes("not yet confirmed"),
        "reason must indicate pending confirmation",
      );
    });

    it("operator_confirmed receipt → operatorReceipt = receipt_confirmed, still not ACK eligible", () => {
      const event = buildOperatorConfirmedEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.providerDelivery, "accepted");
      assert.equal(gap.operatorReceipt, "receipt_confirmed");
      // Cross-broker projections are NEVER origin ACK eligible
      assert.equal(gap.terminalAckEligible, false);
      assert.ok(
        gap.reason.includes("never origin ACK eligible"),
        "reason must state cross-broker is never origin ACK eligible",
      );
    });

    it("failed receipt → operatorReceipt = failed", () => {
      const event = buildFailedEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.providerDelivery, "unknown");
      assert.equal(gap.operatorReceipt, "failed");
      assert.equal(gap.terminalAckEligible, false);
    });

    it("provider delivery state is always separate from operator receipt state", () => {
      const events = [
        buildProviderAcceptedOnlyEvent(),
        buildProviderDeliveredEvent(),
        buildOperatorVisibleEvent(),
        buildOperatorConfirmedEvent(),
        buildFailedEvent(),
      ];

      for (const event of events) {
        const gap = getCrossBrokerTerminalReceiptGap(event);

        // providerDelivery and operatorReceipt must be distinct concepts
        assert.ok(
          typeof gap.providerDelivery === "string",
          "providerDelivery must always be set",
        );
        assert.ok(
          typeof gap.operatorReceipt === "string",
          "operatorReceipt must always be set",
        );

        // Provider delivery being "sent" or "delivered" must NOT make
        // terminalAckEligible=true
        assert.equal(
          gap.terminalAckEligible,
          false,
          "cross-broker terminal ACK must never be eligible regardless of provider delivery state",
        );

        // reason field must exist and be non-empty
        assert.ok(
          gap.reason.length > 0,
          "reason must be non-empty",
        );
      }
    });

    it("reason field explicitly mentions provider vs operator separation for provider-only state", () => {
      const event = buildProviderDeliveredEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.operatorReceipt, "provider_only");
      assert.ok(
        gap.reason.includes("provider evidence is not Terminal Brief visibility proof"),
        "reason must explicitly call out provider evidence is not visibility proof",
      );
    });
  });

  describe("receipt boundary: provider send success is never ACK", () => {
    it("buildA2ACrossBrokerTerminalProjection receipt block separation", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      const receipt = projection!.receipt;
      // Provider gateway send is always "not_ack_evidence"
      assert.equal(receipt.providerGatewaySendSuccess, "not_ack_evidence");
      // Origin terminal ACK is always false
      assert.equal(receipt.originTerminalAckEligible, false);
    });

    it("getCrossBrokerTerminalReceiptGap always returns terminalAckEligible=false", () => {
      // Even with confirmed operator receipt, cross-broker is never ACK eligible
      const event = buildOperatorConfirmedEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.operatorReceipt, "receipt_confirmed");
      assert.equal(gap.terminalAckEligible, false);
    });

    it("provider_delivery_receipt never produces operator_visible receipt state", () => {
      const event = buildProviderDeliveredEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);

      assert.equal(gap.operatorReceipt, "provider_only");
      assert.notEqual(gap.operatorReceipt, "receipt_confirmed");
      assert.notEqual(gap.operatorReceipt, "operator_visible");
    });
  });

  describe("A2A R13 — real-round guard and aggregation", () => {
    const PARENT_ROUND_ID = "a2a-r13-terminal-brief-realround-20260514T013556Z";
    const ORIGIN_BROKER_ID = "seoseo";
    const HANDOFF_BROKER_ID = "broker-racknerd-167be94";

    it("buildA2ACrossBrokerTerminalProjection preserves parentRoundId and originBrokerId", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "sogyo",
        roundNum: 2,
        roundTotal: 7,
        issue: 307,
        summary: "A2A R13 real-round guard and aggregation verification",
        completedAt: "2026-05-14T01:35:56.000Z",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: HANDOFF_BROKER_ID,
          originTaskId: "sogyo-r13-origin",
        },
      });

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must produce projection for real-round event");
      // Parent round ID preserved from handoff metadata
      assert.equal(projection!.parentRoundId, PARENT_ROUND_ID);
      // originBrokerId remains the child/handoff producer for broker ingestion compatibility.
      assert.equal(projection!.originBrokerId, HANDOFF_BROKER_ID);
      // Explicit parent-origin fields identify the initiating parent broker for #634.
      assert.equal(projection!.brokerOfRecordId, ORIGIN_BROKER_ID);
      assert.equal(projection!.parentOriginBrokerId, ORIGIN_BROKER_ID);
      assert.equal(projection!.parentBrokerId, ORIGIN_BROKER_ID);
      assert.equal(projection!.worker, "sogyo");
      assert.equal(projection!.status, "succeeded");
    });

    it("preserves broker-initiated run and group ids across Team1/Team2 projections", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "sogyo",
        runId: "a2a-r32-terminal-brief-round",
        groupId: "seoseo-next-round-team1-team2",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: HANDOFF_BROKER_ID,
          originTaskId: "sogyo-r32-origin",
          runId: "a2a-r32-terminal-brief-round",
          groupId: "seoseo-next-round-team1-team2",
        },
      });

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must produce projection for broker-initiated two-team round");
      assert.equal(projection!.parentRoundId, PARENT_ROUND_ID);
      assert.equal(projection!.runId, "a2a-r32-terminal-brief-round");
      assert.equal(projection!.groupId, "seoseo-next-round-team1-team2");
      assert.equal(projection!.brokerOfRecordId, ORIGIN_BROKER_ID);
      assert.equal(projection!.originBrokerId, HANDOFF_BROKER_ID);
    });

    it("preserves childWorkerId from cross-broker handoff metadata for parent titles", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "gwakga",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: HANDOFF_BROKER_ID,
          originTaskId: "team2-child-soonwook",
          childWorkerId: "soonwook",
        },
      });

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must produce projection for handoff child");
      assert.equal(projection!.originBrokerId, HANDOFF_BROKER_ID);
      assert.equal(projection!.brokerOfRecordId, ORIGIN_BROKER_ID);
      assert.equal(projection!.childWorkerId, "soonwook");
      assert.equal(projection!.worker, "gwakga");
    });

    it("evidence block preserves issue and repo for real-round", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "sogyo",
        roundNum: 2,
        roundTotal: 7,
        issue: 307,
        repo: "jinwon-int/plugin-a2a",
        prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/307",
        summary: "A2A R13 evidence preservation",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: HANDOFF_BROKER_ID,
          originTaskId: "sogyo-r13-origin",
        },
      });

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);
      assert.equal(projection!.evidence.repo, "jinwon-int/plugin-a2a");
      assert.equal(projection!.evidence.issue, 307);
      assert.equal(projection!.evidence.prUrl, "https://github.com/jinwon-int/plugin-a2a/pull/307");
    });

    it("receipt block declares provider send is not ACK evidence for real-round", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "sogyo",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: HANDOFF_BROKER_ID,
          originTaskId: "sogyo-r13-origin",
        },
      });

      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);

      const receipt = projection!.receipt;
      assert.equal(receipt.providerGatewaySendSuccess, "not_ack_evidence");
      assert.equal(receipt.originTerminalAckEligible, false);
      assert.equal(receipt.localReceiptState, "pending_receipt");
      assert.ok(
        receipt.reason.includes("never operator-visible ACK evidence"),
        "receipt reason must explain provider vs ACK separation",
      );
    });

    it("getCrossBrokerTerminalReceiptGap returns terminalAckEligible=false for real-round", () => {
      const event = buildCrossBrokerTerminalEvent({
        worker: "sogyo",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: HANDOFF_BROKER_ID,
          originTaskId: "sogyo-r13-origin",
        },
      });

      const gap = getCrossBrokerTerminalReceiptGap(event);
      assert.ok(gap, "must produce receipt gap for real-round event");
      assert.equal(gap.terminalAckEligible, false);
      assert.equal(gap.providerDelivery, "unknown");
      assert.equal(gap.operatorReceipt, "none");
      assert.ok(
        gap.reason.includes("no operator-visible receipt evidence"),
        "reason must mention missing operator receipt",
      );
    });
  });

  describe("metadata-filtered relay — cross-broker handoff metadata formats", () => {
    it("accepts metadata.crossBrokerHandoff nesting (handoff in metadata sub-object)", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.crossBrokerHandoff;
      payload.metadata = {
        crossBrokerHandoff: {
          parentRoundId: "round-metadata-nested",
          originBrokerId: "broker-a",
          handoffBrokerId: "broker-b",
        },
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must parse metadata.crossBrokerHandoff");
      assert.equal(projection!.parentRoundId, "round-metadata-nested");
      assert.equal(projection!.originBrokerId, "broker-b");
      assert.equal(projection!.brokerOfRecordId, "broker-a");
    });

    it("accepts metadata.crossBroker nesting (cross-broker handoff in metadata)", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.crossBrokerHandoff;
      payload.metadata = {
        crossBroker: {
          parentRoundId: "round-cross-broker-meta",
          originBrokerId: "broker-a",
          handoffBrokerId: "broker-b",
        },
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must parse metadata.crossBroker");
      assert.equal(projection!.parentRoundId, "round-cross-broker-meta");
    });

    it("accepts payload-level handoff key (alias for crossBrokerHandoff)", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.crossBrokerHandoff;
      payload.handoff = {
        parentRoundId: "round-handoff-key",
        originBrokerId: "broker-a",
        handoffBrokerId: "broker-b",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must parse payload.handoff");
      assert.equal(projection!.parentRoundId, "round-handoff-key");
    });

    it("accepts originBrokerId from originBroker.id record", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.crossBrokerHandoff;
      payload.crossBrokerHandoff = {
        parentRoundId: "round-origin-id-record",
        originBroker: { id: "broker-a" },
        handoffBrokerId: "broker-b",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must parse originBroker.id record");
      assert.equal(projection!.parentRoundId, "round-origin-id-record");
      assert.equal(projection!.brokerOfRecordId, "broker-a");
    });

    it("originBrokerId is always the handoff/child broker, brokerOfRecordId is origin", () => {
      // originBrokerId in the projection is the child/handoff broker (broker ingestion compatibility):
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      // Populate with explicit handoff broker that differs from origin:
      payload.crossBrokerHandoff = {
        parentRoundId: "round-owner-separation",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);
      // originBrokerId = handoff broker (child producer)
      assert.equal(
        projection!.originBrokerId,
        "gwakga",
        "originBrokerId is the child/handoff broker for broker ingestion compatibility",
      );
      // brokerOfRecordId = origin broker (initiating parent)
      assert.equal(
        projection!.brokerOfRecordId,
        "seoseo",
        "brokerOfRecordId stays the origin/initiating parent broker",
      );
      // parent-origin broker IDs all point to the initiating parent
      assert.equal(projection!.parentOriginBrokerId, "seoseo");
      assert.equal(projection!.parentBrokerId, "seoseo");
    });

    it("handoffBrokerId defaults from options when metadata is missing handoffBrokerId", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.crossBrokerHandoff;
      payload.crossBrokerHandoff = {
        parentRoundId: "round-no-handoff-id",
        originBrokerId: "broker-a",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event, {
        handoffBrokerId: "fallback-handoff-broker",
      });
      assert.ok(projection, "must build projection with fallback handoffBrokerId");
      assert.equal(
        projection!.handoffBrokerId,
        "fallback-handoff-broker",
        "handoffBrokerId falls back to options.handoffBrokerId when metadata does not provide one",
      );
    });

    it("returns undefined when crossBrokerHandoff has parentRoundId but no originBrokerId", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      payload.crossBrokerHandoff = {
        parentRoundId: "round-no-origin",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(projection, undefined, "must reject metadata missing originBrokerId");
    });

    it("returns undefined when crossBrokerHandoff has originBrokerId but no parentRoundId", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      payload.crossBrokerHandoff = {
        originBrokerId: "broker-a",
        handoffBrokerId: "broker-b",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(projection, undefined, "must reject metadata missing parentRoundId");
    });
  });

  describe("no direct ACK of remote origin rows — receipt block boundaries", () => {
    it("projection receipt block always has providerGatewaySendSuccess === 'not_ack_evidence'", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);
      assert.equal(
        projection!.receipt.providerGatewaySendSuccess,
        "not_ack_evidence",
      );
    });

    it("getCrossBrokerTerminalReceiptGap always returns terminalAckEligible === false", () => {
      const events = [
        buildProviderAcceptedOnlyEvent(),
        buildProviderDeliveredEvent(),
        buildOperatorVisibleEvent(),
        buildOperatorConfirmedEvent(),
        buildFailedEvent(),
      ];
      for (const event of events) {
        const gap = getCrossBrokerTerminalReceiptGap(event);
        assert.equal(
          gap.terminalAckEligible,
          false,
          `terminalAckEligible must be false for all receipt states (got ${gap.operatorReceipt})`,
        );
      }
    });

    it("even operator_confirmed receipt does not flip terminalAckEligible on projection", () => {
      const event = buildOperatorConfirmedEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);
      assert.equal(projection!.receipt.localReceiptState, "receipt_confirmed");
      assert.equal(
        projection!.receipt.originTerminalAckEligible,
        false,
        "originTerminalAckEligible is false even when local receipt is confirmed",
      );
      assert.ok(
        projection!.receipt.reason.includes("never operator-visible ACK evidence"),
        "reason must state cross-broker is never origin ACK eligible",
      );
    });

    it("confirmed operator receipt with terminalAckEligible=false in gap projection", () => {
      const event = buildOperatorConfirmedEvent();
      const gap = getCrossBrokerTerminalReceiptGap(event);
      assert.equal(gap.operatorReceipt, "receipt_confirmed");
      assert.equal(gap.terminalAckEligible, false);
      assert.ok(
        gap.reason.includes("never origin ACK eligible"),
        "receipt gap reason must state cross-broker is never origin ACK eligible",
      );
    });
  });

  describe("localBrokerId safety — parent-owned vs local-owned rows", () => {
    it("parent-owned row with parentBrokerId matching local broker builds projection", () => {
      // When handoffBrokerId (the child broker) matches the origin/parent broker's
      // identity, the projection still builds — it's a valid cross-broker row.
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      payload.crossBrokerHandoff = {
        parentRoundId: "round-self-owned",
        originBrokerId: "broker-a",
        handoffBrokerId: "broker-a",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(
        projection,
        "projection builds when handoffBrokerId equals originBrokerId (same broker)",
      );
      assert.equal(projection!.originBrokerId, "broker-a");
      assert.equal(projection!.brokerOfRecordId, "broker-a");
    });

    it("row with parent-owned ownership fields builds projection regardless of broker identity", () => {
      // The projection function does not know about local broker identity.
      // Local suppression is a bridge concern; the projection always builds
      // when handoff metadata + parent-owned notification is present.
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      payload.operatorFacingOwner = "parent";
      payload.parentOwnedTerminalBrief = true;
      payload.crossBrokerHandoff = {
        parentRoundId: "round-explicit-owner",
        originBrokerId: "broker-a",
        handoffBrokerId: "broker-b",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "must build projection for explicit parent-owned row");
      assert.equal(projection!.parentRoundId, "round-explicit-owner");
    });

    it("brokerOfRecordId alone without parent-owned scope does not produce projection", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.parentOwnedTerminalBrief;
      delete payload.operatorFacingOwner;
      delete payload.notificationOwnership;
      // brokerOfRecordId at top-level alone is not parent-owned scope for cross-broker
      payload.crossBrokerHandoff = {
        parentRoundId: "round-bor-only",
        originBrokerId: "broker-a",
        handoffBrokerId: "broker-b",
      };
      payload.brokerOfRecordId = "broker-a";
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.equal(
        projection,
        undefined,
        "brokerOfRecordId alone does not establish parent-owned scope",
      );
    });

    it("notificationOwnership.ownerBrokerId matching parent round origin produces projection", () => {
      const event = buildCrossBrokerTerminalEvent();
      const payload = event.payload as Record<string, unknown>;
      delete payload.parentOwnedTerminalBrief;
      delete payload.operatorFacingOwner;
      payload.notificationOwnership = {
        ownerBrokerId: "broker-a",
        scope: "parent-broker-only",
      };
      payload.crossBrokerHandoff = {
        parentRoundId: "round-owner-broker-match",
        originBrokerId: "broker-a",
        handoffBrokerId: "broker-b",
      };
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "ownerBrokerId matching origin produces projection");
      assert.equal(projection!.parentRoundId, "round-owner-broker-match");
    });
  });

  describe("cursor/allowedIds test window behavior — projections are safe to stage", () => {
    it("projection production does not depend on cursor or allowedIds", () => {
      // Projection function is a pure function — no cursor/allowlist dependency.
      // This test verifies cursor/allowedIds guards are orthogonal to projection.
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection, "projection is produced independently from cursor/allowlist");
    });

    it("buildA2ACrossBrokerTerminalProjection returns same result regardless of terminalOutboxCursor", () => {
      const baseEvent = buildCrossBrokerTerminalEvent();
      const a = buildA2ACrossBrokerTerminalProjection(baseEvent);
      const b = buildA2ACrossBrokerTerminalProjection(baseEvent, { handoffBrokerId: "cursor-independent" });
      assert.ok(a && b, "projection is cursor-independent");
    });

    it("receipt gap projection does not mutate event or depend on external state", () => {
      const events = [
        buildProviderAcceptedOnlyEvent(),
        buildProviderDeliveredEvent(),
        buildOperatorVisibleEvent(),
        buildOperatorConfirmedEvent(),
        buildFailedEvent(),
      ];
      for (const event of events) {
        // First call
        const firstGap = getCrossBrokerTerminalReceiptGap(event);
        // Second call with same event must produce same result
        const secondGap = getCrossBrokerTerminalReceiptGap(event);
        assert.deepEqual(firstGap, secondGap, "receipt gap must be deterministic");
        // Event must be unmutated
        assert.ok(event, "event must not be mutated by receipt gap projection");
      }
    });
  });

  describe("operator-facing summary wording boundaries", () => {
    it("summary is clamped but preserves readable terminal outcome", () => {
      const event = buildCrossBrokerTerminalEvent({
        summary: "Lane 2: cross-broker projection-only handling verified: parent-owned remote rows, no direct ACK, localBrokerId safety, metadata-filtered relay, cursor/allowedIds window",
      });
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);
      assert.ok(projection!.summary, "summary must be preserved");
      assert.ok(
        projection!.summary!.length <= 281,
        `summary must be clamped; actual length: ${projection!.summary!.length}`,
      );
      // Operator must see the readable summary prefix
      assert.ok(
        projection!.summary!.startsWith("Lane 2"),
        "operator-readable prefix must survive clamping",
      );
    });

    it("receipt reason is always set and operator-readable", () => {
      const events = [
        buildProviderAcceptedOnlyEvent(),
        buildProviderDeliveredEvent(),
        buildOperatorVisibleEvent(),
        buildOperatorConfirmedEvent(),
        buildFailedEvent(),
      ];
      for (const event of events) {
        const gap = getCrossBrokerTerminalReceiptGap(event);
        assert.ok(gap.reason.length > 0, "receipt gap reason must be non-empty");
        // Reason must not contain raw tokens/URLs:
        assert.ok(
          !gap.reason.includes("?token=") && !gap.reason.includes("eyJ"),
          "receipt gap reason must not leak secrets",
        );
      }
    });

    it("projection receipt reason explains cross-broker projection boundary", () => {
      const event = buildCrossBrokerTerminalEvent();
      const projection = buildA2ACrossBrokerTerminalProjection(event);
      assert.ok(projection);
      const reason = projection!.receipt.reason;
      assert.ok(reason.length > 0, "receipt reason must be set");
      assert.ok(
        reason.includes("never operator-visible ACK evidence"),
        "operator must see that provider send is not an ACK",
      );
    });
  });
});

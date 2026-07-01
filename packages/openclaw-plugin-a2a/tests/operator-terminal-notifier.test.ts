/**
 * Operator terminal notifier tests — concise parent-round Terminal Brief titles (#290).
 *
 * Parent: jinwon-int/plugin-a2a#290
 * Origin: jinwon-int/a2a-broker#544
 *
 * Verifies the concise title format: "A2A Terminal Brief 완료: dungae(1/7)"
 * for both direct parent-broker tasks and cross-broker projected child tasks.
 * No live send, no terminal ACK, no Gateway restart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A2A_OPERATOR_TERMINAL_BRIEF_DEFAULT_TITLE_FORMAT,
  buildA2AOperatorTerminalNotificationEnvelope,
  buildA2AOperatorTerminalOutboxNotificationEnvelope,
  buildA2AOpenClawTelegramOperatorNotification,
  createA2ATelegramSafeDryRunNotificationHarness,
  renderA2AOperatorTerminalBriefDefaultTitle,
  renderA2AOperatorTerminalBriefTemplate,
} from "../dist/src/operator-terminal-notifier.js";
import { renderOperatorNotificationText } from "../dist/src/operator-notification-adapter.js";

// ── Helpers ────────────────────────────────────────────────────────

function roundProgressPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId: "sogyo-290",
    status: "succeeded",
    worker: "sogyo",
    repo: "jinwon-int/plugin-a2a",
    issue: 290,
    testSummary: "concise Terminal Brief title proof",
    ...overrides,
  };
}

// ── Direct parent-broker tasks (outbox) ─────────────────────────────

describe("buildA2AOperatorTerminalOutboxNotificationEnvelope — concise titles", () => {
  it("locks the default manager-facing title format", () => {
    assert.equal(
      A2A_OPERATOR_TERMINAL_BRIEF_DEFAULT_TITLE_FORMAT,
      "A2A Terminal Brief 완료: worker(완료 1/3)",
    );
    assert.equal(
      renderA2AOperatorTerminalBriefDefaultTitle({
        type: "success",
        worker: "worker",
        roundNum: 1,
        roundTotal: 3,
      }),
      A2A_OPERATOR_TERMINAL_BRIEF_DEFAULT_TITLE_FORMAT,
    );
  });

  it("renders concise title with worker and round progress", () => {
    const outbox = {
      id: "outbox:direct:sogyo:1",
      kind: "task.terminal" as const,
      attempts: 1,
      createdAt: "2026-05-13T06:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T06:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T06:00:00.000Z",
      },
      payload: roundProgressPayload({
        roundNum: 1,
        roundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "expected envelope");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(완료 1/7)");
    assert.equal(envelope!.roundNum, 1);
    assert.equal(envelope!.roundTotal, 7);
  });

  it("renders concise title for mid-round completion", () => {
    const outbox = {
      id: "outbox:direct:nosuk:4",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T07:00:00.000Z",
      },
      payload: roundProgressPayload({
        worker: "nosuk",
        roundNum: 4,
        roundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: nosuk(완료 4/7)");
    assert.equal(envelope!.roundNum, 4);
    assert.equal(envelope!.roundTotal, 7);
  });

  it("renders concise title for final worker completion", () => {
    const outbox = {
      id: "outbox:direct:dungae:7",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T08:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T08:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T08:00:00.000Z",
      },
      payload: roundProgressPayload({
        worker: "dungae",
        roundNum: 7,
        roundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: dungae(완료 7/7)");
  });

  it("reads round progress from crossBrokerHandoff metadata", () => {
    const outbox = {
      id: "outbox:cross:gwakga:3",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T06:30:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T06:30:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "cross-broker projection; awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T06:30:00.000Z",
      },
      payload: {
        taskId: "gwakga-child-3",
        status: "succeeded",
        worker: "gwakga",
        repo: "a2a-plane (internal tracker, private)",
        issue: 276,
        testSummary: "gwakga handoff completed",
        crossBrokerHandoff: {
          parentRoundId: "parent-seoseo",
          originBrokerId: "seoseo",
          handoffBrokerId: "gwakga",
          originTaskId: "child-3",
          roundNum: 3,
          roundTotal: 7,
        },
        completedAt: "2026-05-13T06:30:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: gwakga(완료 3/7)");
    assert.equal(envelope!.roundNum, 3);
    assert.equal(envelope!.roundTotal, 7);
  });

  it("readRoundNum reads from parentRoundNum field", () => {
    const outbox = {
      id: "outbox:direct:parentRoundNum",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:00:00.000Z",
      },
      payload: roundProgressPayload({
        parentRoundNum: 2,
        parentRoundTotal: 5,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.roundNum, 2);
    assert.equal(envelope!.roundTotal, 5);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(완료 2/5)");
  });

  it("reads broker parentRoundProgress with parentRoundTotal", () => {
    const outbox = {
      id: "outbox:direct:parentRoundProgress",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:05:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:05:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:05:00.000Z",
      },
      payload: roundProgressPayload({
        worker: "worker",
        parentRoundProgress: 3,
        parentRoundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.roundNum, 3);
    assert.equal(envelope!.roundTotal, 7);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: worker(완료 3/7)");
  });

  it("does not treat parentRoundOrder as completed progress and marks missing completed progress", () => {
    const outbox = {
      id: "outbox:direct:parentRoundOrder-not-progress",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:05:30.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:05:30.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:05:30.000Z",
      },
      payload: roundProgressPayload({
        worker: "nosuk",
        parentRoundOrder: 3,
        parentRoundTotal: 4,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.roundNum, undefined);
    assert.equal(envelope!.roundTotal, 4);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: nosuk(완료 ?/?)");
  });

  it("prefers completed/total progress over parentRoundOrder lane index", () => {
    const outbox = {
      id: "outbox:direct:completed-progress-over-order",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:05:40.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:05:40.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:05:40.000Z",
      },
      payload: roundProgressPayload({
        worker: "nosuk",
        parentRoundOrder: 3,
        roundProgress: { completed: 2 },
        parentRoundTotal: 4,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.roundNum, 2);
    assert.equal(envelope!.roundTotal, 4);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: nosuk(완료 2/4)");
  });

  it("reads compatible roundProgress.completed with parentRoundTotal", () => {
    const outbox = {
      id: "outbox:direct:roundProgressCompleted",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:06:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:06:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:06:00.000Z",
      },
      payload: roundProgressPayload({
        worker: "worker",
        roundProgress: { completed: 4 },
        parentRoundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.roundNum, 4);
    assert.equal(envelope!.roundTotal, 7);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: worker(완료 4/7)");
  });

  it("labels completed progress explicitly when parentRoundOrder=4/4 with parentRoundProgress=1/4", () => {
    const outbox = {
      id: "outbox:direct:parentRoundOrder4-progress1",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:05:50.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:05:50.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:05:50.000Z",
      },
      payload: roundProgressPayload({
        worker: "work-sogyo",
        parentRoundOrder: 4,
        parentRoundProgress: 1,
        parentRoundTotal: 4,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    // roundNum must come from parentRoundProgress, NOT parentRoundOrder
    assert.equal(envelope!.roundNum, 1);
    assert.equal(envelope!.roundTotal, 4);
    // Title must label completed progress explicitly, not bare work-sogyo(4/4)
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: work-sogyo(완료 1/4)");
  });

  it("falls back without denominator for broker parentRoundProgress", () => {
    const outbox = {
      id: "outbox:direct:parentRoundProgress-no-total",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:07:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:07:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:07:00.000Z",
      },
      payload: roundProgressPayload({
        worker: "worker",
        parentRoundProgress: 5,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: worker");
    assert.equal(envelope!.roundNum, 5);
    assert.equal(envelope!.roundTotal, undefined);
  });

  it("renders single-worker progress as 1/1 when denominator is absent", () => {
    const outbox = {
      id: "outbox:direct:single-worker-no-total",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-17T04:24:18.476Z",
      receipt: { status: "accepted", updatedAt: "2026-05-17T04:24:18.476Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-17T04:24:18.476Z",
      },
      payload: roundProgressPayload({
        taskId: "team1-sogyo-322-observation-seoseo-20260517T041718Z",
        worker: "sogyo",
        roundNum: 1,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.roundNum, 1);
    assert.equal(envelope!.roundTotal, undefined);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(1/1)");
  });

  it("fails safe to worker-only label when roundTotal is unknown", () => {
    const outbox = {
      id: "outbox:direct:no-total",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:10:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:10:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:10:00.000Z",
      },
      payload: roundProgressPayload({
        roundNum: 3,
        // roundTotal intentionally omitted
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo");
    assert.equal(envelope!.roundNum, 3);
    assert.equal(envelope!.roundTotal, undefined);
  });

  it("fails safe to worker-only label when roundNum is zero", () => {
    const outbox = {
      id: "outbox:direct:zero-num",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:20:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:20:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:20:00.000Z",
      },
      payload: roundProgressPayload({
        roundNum: 0,
        roundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo");
  });

  it("fails safe to worker-only label when roundNum exceeds roundTotal", () => {
    const outbox = {
      id: "outbox:direct:overflow",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:30:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:30:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:30:00.000Z",
      },
      payload: roundProgressPayload({
        roundNum: 8,
        roundTotal: 7,
      }),
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo");
  });

  it("renders standalone task-based label as 1/1 when round progress is unavailable", () => {
    const outbox = {
      id: "outbox:direct:no-worker-no-progress",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T09:40:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T09:40:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T09:40:00.000Z",
      },
      payload: {
        taskId: "fallback-1",
        status: "succeeded",
        repo: "a2a-plane (internal tracker, private)",
        issue: 999,
        testSummary: "fallback test",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: task fallback-1(1/1)");
  });

  it("renders failure type with concise title", () => {
    const outbox = {
      id: "outbox:direct:failed",
      kind: "task.terminal" as const,
      attempts: 1,
      createdAt: "2026-05-13T10:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T10:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T10:00:00.000Z",
      },
      payload: {
        taskId: "failed-task",
        status: "failed",
        worker: "sogyo",
        roundNum: 5,
        roundTotal: 7,
        testSummary: "task failed",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 실패: sogyo(5/7)");
    assert.equal(envelope!.type, "failure");
    assert.equal(envelope!.severity, "error");
  });

  it("renders block type with concise title", () => {
    const outbox = {
      id: "outbox:direct:blocked",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T10:10:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T10:10:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T10:10:00.000Z",
      },
      payload: {
        taskId: "blocked-task",
        status: "block",
        worker: "nosuk",
        roundNum: 6,
        roundTotal: 7,
        testSummary: "task blocked awaiting approval",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 차단: nosuk(6/7)");
    assert.equal(envelope!.type, "block");
    assert.equal(envelope!.severity, "warn");
  });
});

// ── Direct parent-broker tasks (live stream) ────────────────────────

describe("buildA2AOperatorTerminalNotificationEnvelope — concise titles", () => {
  it("renders concise title from live terminal event", () => {
    const event = {
      id: "live:seoseo:2",
      name: "operator-summary-update",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "seoseo-direct-2",
          worker: "seoseo",
          repo: "jinwon-int/a2a-broker",
          issue: 544,
          summary: "parent round progress",
          roundNum: 2,
          roundTotal: 5,
          receiptProjection: "current_session_visible",
          completedAt: "2026-05-13T07:00:00.000Z",
        },
      },
    };

    const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
    assert.ok(envelope, "expected envelope");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: seoseo(완료 2/5)");
    assert.equal(envelope!.roundNum, 2);
    assert.equal(envelope!.roundTotal, 5);
  });

  it("reads round progress from metadata in live event", () => {
    const event = {
      id: "live:metadata:progress",
      name: "operator-summary-update",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "metadata-task",
          worker: "gwakga",
          repo: "a2a-plane (internal tracker, private)",
          summary: "metadata progress",
          receiptProjection: "current_session_visible",
          metadata: {
            roundNum: 1,
            roundTotal: 8,
          },
        },
      },
    };

    const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: gwakga(완료 1/8)");
  });

  it("reads round progress from crossBroker metadata in live event", () => {
    const event = {
      id: "live:cross:progress",
      name: "operator-summary-update",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "cross-live",
          worker: "soonwook",
          repo: "a2a-plane (internal tracker, private)",
          summary: "cross live progress",
          receiptProjection: "current_session_visible",
          crossBrokerHandoff: {
            parentRoundId: "parent-seoseo",
            roundNum: 4,
            roundTotal: 7,
          },
        },
      },
    };

    const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: soonwook(완료 4/7)");
  });

  it("renders standalone live event as 1/1 when round progress is absent", () => {
    const event = {
      id: "live:no-progress",
      name: "operator-summary-update",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "no-progress-task",
          worker: "dungae",
          summary: "no progress data",
          receiptProjection: "current_session_visible",
        },
      },
    };

    const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: dungae(1/1)");
  });
});

// ── Adapter notification rendering ────────────────────────────────

describe("renderOperatorNotificationText — broker progress fields", () => {
  it("renders parentRoundProgress/parentRoundTotal when adapter receives broker-shaped envelope", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:broker-progress",
      dedupeKey: "broker-progress",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: worker",
      text: "broker progress adapter proof",
      worker: "worker",
      parentRoundProgress: 6,
      parentRoundTotal: 7,
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "worker" },
    });

    assert.match(text, /^A2A Terminal Brief 완료: worker\(완료 6\/7\)$/m);
  });

  it("renders roundProgress.completed/parentRoundTotal when adapter receives compatible broker envelope", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:broker-roundProgress",
      dedupeKey: "broker-roundProgress",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: worker",
      text: "broker roundProgress adapter proof",
      worker: "worker",
      roundProgress: { completed: 2 },
      parentRoundTotal: 7,
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "worker" },
    });

    assert.match(text, /^A2A Terminal Brief 완료: worker\(완료 2\/7\)$/m);
  });

  it("preserves adapter fallback without denominator", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:broker-progress-no-total",
      dedupeKey: "broker-progress-no-total",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: worker",
      text: "broker progress no denominator proof",
      worker: "worker",
      parentRoundProgress: 6,
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "worker" },
    });

    assert.match(text, /^A2A Terminal Brief 완료: worker 작업$/m);
    assert.doesNotMatch(text, /worker\(6\//);
  });

  it("renders adapter single-worker progress as 1/1 when denominator is absent", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:single-worker-no-total",
      dedupeKey: "single-worker-no-total",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: sogyo",
      text: "single worker no denominator proof",
      worker: "sogyo",
      roundProgress: { completed: 1 },
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "sogyo" },
    });

    assert.match(text, /^A2A Terminal Brief 완료: sogyo\(1\/1\)$/m);
  });

  it("renders explicit completed progress label when adapter receives parentRoundOrder=4/4 with parentRoundProgress=1/4", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:order4-progress1",
      dedupeKey: "order4-progress1",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: work-sogyo",
      text: "broker parentRoundOrder + parentRoundProgress proof",
      worker: "work-sogyo",
      parentRoundOrder: 4,
      parentRoundProgress: 1,
      parentRoundTotal: 4,
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "work-sogyo" },
    });

    // Must show completed progress explicitly, not bare work-sogyo(4/4)
    assert.match(text, /^A2A Terminal Brief 완료: work-sogyo\(완료 1\/4\)$/m);
    // Must NOT show bare (4/4) which is lane order, not completed progress
    assert.doesNotMatch(text, /sogyo\(4\/4\)/);
  });
});

// ── Telegram notification mapping ──────────────────────────────────

describe("buildA2AOpenClawTelegramOperatorNotification", () => {
  it("preserves concise title in Telegram notification", () => {
    const harness = createA2ATelegramSafeDryRunNotificationHarness();

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope({
      id: "outbox:telegram:concise",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T10:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T10:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T10:00:00.000Z",
      },
      payload: roundProgressPayload({
        worker: "dungae",
        roundNum: 1,
        roundTotal: 7,
      }),
    });

    assert.ok(envelope);
    harness.notify(envelope!);
    const telegram = harness.listTelegram();

    assert.equal(telegram.length, 1);
    assert.equal(telegram[0].title, "A2A Terminal Brief 완료: dungae(완료 1/7)");
    assert.equal(telegram[0].text, "A2A Terminal Brief 완료: dungae(완료 1/7)");
    assert.equal(telegram[0].evidence.worker, "dungae");
  });
});

// ── Harness dry-run safety ─────────────────────────────────────────

describe("createA2ATelegramSafeDryRunNotificationHarness", () => {
  it("never sends live Telegram messages — dry-run only", () => {
    const harness = createA2ATelegramSafeDryRunNotificationHarness();

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope({
      id: "outbox:dry-run:safety",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T10:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T10:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T10:00:00.000Z",
      },
      payload: roundProgressPayload({ roundNum: 3, roundTotal: 7 }),
    });

    assert.ok(envelope);
    harness.notify(envelope!);

    const list = harness.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].dryRun, true);

    const stats = harness.stats();
    assert.equal(stats.accepted, 1);
    assert.equal(stats.dropped, 0);
  });

  it("drops notifications beyond maxNotifications limit", () => {
    const harness = createA2ATelegramSafeDryRunNotificationHarness({ maxNotifications: 2 });

    for (let i = 1; i <= 5; i++) {
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope({
        id: `outbox:drop:${i}`,
        kind: "task.terminal" as const,
        attempts: 0,
        createdAt: "2026-05-13T10:00:00.000Z",
        receipt: { status: "accepted", updatedAt: "2026-05-13T10:00:00.000Z" },
        ackAudit: {
          decision: "pending",
          reason: "awaiting current-session-visible evidence before ACK",
          updatedAt: "2026-05-13T10:00:00.000Z",
        },
        payload: roundProgressPayload({ roundNum: i, roundTotal: 7 }),
      });

      if (envelope) harness.notify(envelope);
    }

    const stats = harness.stats();
    assert.equal(stats.accepted, 2);
    assert.equal(stats.dropped, 3);
  });
});

// ── Seoseo-origin and Gwakga-origin coverage ───────────────────────

describe("concise titles — origin coverage", () => {
  it("renders Seoseo-origin parent round title", () => {
    const outbox = {
      id: "outbox:seoseo:parent:1",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T07:00:00.000Z",
      },
      payload: {
        taskId: "seoseo-parent",
        status: "succeeded",
        worker: "seoseo",
        repo: "jinwon-int/a2a-broker",
        issue: 544,
        roundNum: 1,
        roundTotal: 7,
        testSummary: "seoseo parent round progress",
        crossBrokerHandoff: {
          parentRoundId: "parent-seoseo",
          originBrokerId: "seoseo",
          originTaskId: "seoseo-parent",
        },
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: seoseo(완료 1/7)");
    assert.equal(envelope!.worker, "seoseo");
  });

  it("renders Gwakga-origin parent round title via cross-broker projection", () => {
    const outbox = {
      id: "outbox:gwakga:synthetic:1",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T07:30:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T07:30:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "cross-broker terminal projection accepted; awaiting parent-broker current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T07:30:00.000Z",
      },
      payload: {
        taskId: "gwakga-child",
        status: "succeeded",
        worker: "gwakga",
        repo: "a2a-plane (internal tracker, private)",
        issue: 276,
        roundNum: 2,
        roundTotal: 7,
        testSummary: "gwakga cross-broker projection",
        crossBrokerHandoff: {
          parentRoundId: "parent-gwakga",
          originBrokerId: "gwakga-vps7",
          handoffBrokerId: "seoseo",
          originTaskId: "gwakga-child",
        },
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: gwakga(완료 2/7)");
    assert.equal(envelope!.worker, "gwakga");
  });
});

// ── Body preserves detailed evidence ───────────────────────────────

describe("concise titles — evidence preserved in body", () => {
  it("preserves full evidence in text body while keeping title concise", () => {
    const outbox = {
      id: "outbox:evidence:rich",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-13T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-13T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-13T07:00:00.000Z",
      },
      payload: {
        taskId: "sogyo-290",
        status: "succeeded",
        worker: "sogyo",
        repo: "jinwon-int/plugin-a2a",
        issue: 290,
        prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/291",
        doneUrl: "https://github.com/jinwon-int/plugin-a2a/pull/291#issuecomment-1",
        roundNum: 1,
        roundTotal: 7,
        testSummary: "concise Terminal Brief title proof",
        completedAt: "2026-05-13T07:00:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(완료 1/7)");
    // Detailed evidence remains in body
    assert.ok(envelope!.text.includes("concise Terminal Brief title proof"));
    assert.ok(envelope!.text.includes("Worker: sogyo"));
    assert.ok(envelope!.text.includes("Repo: jinwon-int/plugin-a2a"));
    assert.ok(envelope!.text.includes("Issue: https://github.com/jinwon-int/plugin-a2a/issues/290"));
    assert.ok(envelope!.text.includes("PR: https://github.com/jinwon-int/plugin-a2a/pull/291"));
    // Evidence object preserves details
    assert.equal(envelope!.evidence.worker, "sogyo");
    assert.equal(envelope!.evidence.repo, "jinwon-int/plugin-a2a");
  });
});

// ── A2A R13 real-round guard and aggregation ──────────────────────────

describe("A2A R13 — real-round guard and aggregation", () => {
  const PARENT_ROUND_ID = "a2a-r13-terminal-brief-realround-20260514T013556Z";
  const ORIGIN_BROKER_ID = "seoseo";

  it("renders compact title sogyo(2/7) for real-round metadata", () => {
    const outbox = {
      id: "outbox:r13:sogyo:2",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-14T01:35:56.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-14T01:35:56.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-14T01:35:56.000Z",
      },
      payload: {
        taskId: "sogyo-r13-2",
        status: "succeeded",
        worker: "sogyo",
        repo: "jinwon-int/plugin-a2a",
        issue: 307,
        roundNum: 2,
        roundTotal: 7,
        parentRoundId: PARENT_ROUND_ID,
        originBrokerId: ORIGIN_BROKER_ID,
        testSummary: "A2A R13 compact Terminal Brief real-round guard and aggregation verification",
        prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/307",
        completedAt: "2026-05-14T01:35:56.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "expected envelope for real-round sogyo");
    // Compact title verification
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(완료 2/7)");
    assert.equal(envelope!.roundNum, 2);
    assert.equal(envelope!.roundTotal, 7);
    assert.equal(envelope!.worker, "sogyo");
    // Body preserves detailed evidence
    assert.ok(envelope!.text.includes("A2A R13 compact Terminal Brief real-round guard and aggregation verification"));
    assert.ok(envelope!.text.includes("Worker: sogyo"));
    assert.ok(envelope!.text.includes("Repo: jinwon-int/plugin-a2a"));
    assert.ok(envelope!.text.includes("Issue: https://github.com/jinwon-int/plugin-a2a/issues/307"));
    // Evidence object preserves details
    assert.equal(envelope!.evidence.worker, "sogyo");
    assert.equal(envelope!.evidence.repo, "jinwon-int/plugin-a2a");
    assert.ok(
      envelope!.evidence.issueUrl?.includes("issues/307"),
      "evidence issueUrl must reference issue 307",
    );
  });

  it("crossBrokerHandoff with originBrokerId=seoseo renders compact title", () => {
    const outbox = {
      id: "outbox:r13:sogyo:handoff",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-14T01:35:56.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-14T01:35:56.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "cross-broker projection; awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-14T01:35:56.000Z",
      },
      payload: {
        taskId: "sogyo-r13-handoff",
        status: "succeeded",
        worker: "sogyo",
        repo: "jinwon-int/plugin-a2a",
        issue: 307,
        roundNum: 2,
        roundTotal: 7,
        testSummary: "handoff with seoseo origin broker",
        crossBrokerHandoff: {
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          handoffBrokerId: "broker-racknerd-167be94",
          originTaskId: "sogyo-r13-origin",
        },
        completedAt: "2026-05-14T01:35:56.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "expected envelope for cross-broker handoff sogyo");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(완료 2/7)");
    assert.equal(envelope!.roundNum, 2);
    assert.equal(envelope!.roundTotal, 7);
  });

  it("parent-only Terminal Brief ownership: notification body preserves broker fields", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r13:parent-ownership",
      name: "operator-summary-update",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "sogyo-r13-live",
          worker: "sogyo",
          repo: "jinwon-int/plugin-a2a",
          issue: 307,
          summary: "parent-only Terminal Brief ownership — seoseo origin broker",
          roundNum: 2,
          roundTotal: 7,
          parentRoundId: PARENT_ROUND_ID,
          originBrokerId: ORIGIN_BROKER_ID,
          receiptProjection: "current_session_visible",
          completedAt: "2026-05-14T01:35:56.000Z",
        },
      },
    });

    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(완료 2/7)");
    assert.equal(envelope!.roundNum, 2);
    assert.equal(envelope!.roundTotal, 7);
    assert.equal(envelope!.worker, "sogyo");
  });

  it("renderOperatorNotificationText produces correct receipt wording for sogyo(2/7)", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r13-receipt",
      dedupeKey: "r13-receipt",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: sogyo",
      text: "A2A R13 receipt wording verification",
      worker: "sogyo",
      roundNum: 2,
      roundTotal: 7,
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "sogyo" },
    });

    assert.match(text, /^A2A Terminal Brief 완료: sogyo\(완료 2\/7\)$/m);
    assert.ok(text.includes("sogyo"));
  });

  it("fails safe for invalid round progress: roundNum beyond total", () => {
    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope({
      id: "outbox:r13:invalid",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-14T01:35:56.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-14T01:35:56.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-14T01:35:56.000Z",
      },
      payload: {
        taskId: "sogyo-invalid",
        status: "succeeded",
        worker: "sogyo",
        roundNum: 8,
        roundTotal: 7,
        testSummary: "invalid round progress",
      },
    });

    assert.ok(envelope);
    // Invalid roundNum > roundTotal falls back to worker-only label
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo");
  });
});

// ── R15 structured Terminal Brief: terminalBriefTitle and human summary precedence ──

describe("R15 — terminalBriefTitle and human summary precedence (#311)", () => {
  it("terminalBriefTitle wins when present in outbox payload", () => {
    const outbox = {
      id: "outbox:r15:brief-title",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-14T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-14T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-14T07:00:00.000Z",
      },
      payload: {
        taskId: "r15-brief-title",
        status: "succeeded",
        worker: "yukson",
        roundNum: 4,
        roundTotal: 7,
        terminalBriefTitle: "A2A Terminal Brief 완료: yukson(4/7)",
        summary: "docker runner completed a2a-r15-hardening",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: yukson(4/7)");
    assert.equal(envelope!.terminalBriefTitle, "A2A Terminal Brief 완료: yukson(4/7)");
  });

  it("normalizes standard single-worker terminalBriefTitle to 1/1", () => {
    const outbox = {
      id: "outbox:r15:single-worker-bare-title",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-17T06:04:19.338Z",
      receipt: { status: "accepted", updatedAt: "2026-05-17T06:04:19.338Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-17T06:04:19.338Z",
      },
      payload: {
        taskId: "single-worker-suffix",
        status: "succeeded",
        worker: "sogyo",
        parentRoundProgress: 1,
        terminalBriefTitle: "A2A Terminal Brief 완료: sogyo",
        summary: "single-worker suffix proof",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.terminalBriefTitle, "A2A Terminal Brief 완료: sogyo");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(1/1)");
  });

  it("marks parent-round bare terminalBriefTitle as missing progress when denominator is absent", () => {
    const outbox = {
      id: "outbox:r15:parent-round-bare-title",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-20T02:10:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-20T02:10:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-20T02:10:00.000Z",
      },
      payload: {
        taskId: "team1-terminal-brief-round-nosuk",
        status: "succeeded",
        worker: "nosuk",
        roundId: "team1-terminal-brief-round",
        terminalBriefTitle: "A2A Terminal Brief 완료: nosuk",
        summary: "team1 all-hands worker completed without denominator metadata",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.parentRoundId, "team1-terminal-brief-round");
    assert.equal(envelope!.parentRoundContext, true);
    assert.equal(envelope!.roundNum, undefined);
    assert.equal(envelope!.roundTotal, undefined);
    assert.equal(envelope!.terminalBriefTitle, "A2A Terminal Brief 완료: nosuk");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: nosuk(완료 ?/?)");
  });

  it("terminalBriefTitle wins in live-terminal envelope", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r15:brief-title",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-r15-event",
          worker: "yukson",
          roundNum: 4,
          roundTotal: 7,
          terminalBriefTitle: "A2A Terminal Brief 완료: yukson(4/7)",
          receiptProjection: "current_session_visible",
        },
      },
    });

    assert.ok(envelope);
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: yukson(4/7)");
    assert.equal(envelope!.terminalBriefTitle, "A2A Terminal Brief 완료: yukson(4/7)");
  });

  it("terminalBriefTitle takes precedence over worker+round format", () => {
    const outbox = {
      id: "outbox:r15:precedence",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-14T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-14T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-14T07:00:00.000Z",
      },
      payload: {
        taskId: "r15-custom-title",
        status: "succeeded",
        worker: "nosuk",
        roundNum: 3,
        roundTotal: 7,
        terminalBriefTitle: "A2A Terminal Brief 완료: Team nosuk(3/7) 🎉",
        summary: "runner completed nosuk r15",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(
      envelope!.title,
      "A2A Terminal Brief 완료: Team nosuk(3/7) 🎉",
    );
  });

  it("evidence object contains taskSummary and taskBrief from payload", () => {
    const outbox = {
      id: "outbox:r15:human-summary",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-14T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-14T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-14T07:00:00.000Z",
      },
      payload: {
        taskId: "task-r15-human",
        status: "succeeded",
        worker: "nosuk",
        roundNum: 3,
        roundTotal: 7,
        taskDescription: "deploy marker aware runner doctor",
        taskSummary: "marker aware runner deployment",
        taskBrief: "deploy runner doctor",
        summary: "docker runner completed a2a-r15-hardening-20260514",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope);
    assert.equal(envelope!.evidence.taskDescription, "deploy marker aware runner doctor");
    assert.equal(envelope!.evidence.taskSummary, "marker aware runner deployment");
    assert.equal(envelope!.evidence.taskBrief, "deploy runner doctor");
    // Runner lifecycle string remains available as fallback evidence
    assert.equal(envelope!.evidence.summary, "docker runner completed a2a-r15-hardening-20260514");
  });

  it("renderOperatorNotificationText omits 업무 details even when taskDescription exists", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r15-work-line",
      dedupeKey: "r15-work-line",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: nosuk(3/7)",
      text: "A2A Terminal Brief 완료: nosuk(3/7)\n업무: deploy marker aware runner doctor",
      worker: "nosuk",
      roundNum: 3,
      roundTotal: 7,
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        worker: "nosuk",
        taskDescription: "deploy marker aware runner doctor",
        summary: "docker runner completed a2a-r15-hardening-20260514",
      },
    });

    assert.equal(text, "A2A Terminal Brief 완료: nosuk(완료 3/7)");
    assert.doesNotMatch(text, /업무:/);
    assert.doesNotMatch(text, /docker runner completed/);
  });

  it("renderOperatorNotificationText omits 업무 fallback summary when no human summary", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r15-fallback",
      dedupeKey: "r15-fallback",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: yukson(4/7)",
      text: "A2A Terminal Brief 완료: yukson(4/7)\n업무: docker runner completed",
      worker: "yukson",
      roundNum: 4,
      roundTotal: 7,
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        worker: "yukson",
        summary: "docker runner completed a2a-r15-hardening-20260514",
      },
    });

    assert.equal(text, "A2A Terminal Brief 완료: yukson(완료 4/7)");
    assert.doesNotMatch(text, /업무:/);
    assert.doesNotMatch(text, /docker runner completed/);
  });

  it("renderCompactOperatorNotificationTitle uses terminalBriefTitle", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r15-adapter-title",
      dedupeKey: "r15-adapter-title",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: yukson(4/7)",
      text: "A2A Terminal Brief 완료: yukson(4/7)",
      worker: "yukson",
      roundNum: 4,
      roundTotal: 7,
      terminalBriefTitle: "A2A Terminal Brief 완료: yukson(4/7)",
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        worker: "yukson",
        taskDescription: "deploy marker aware runner doctor",
      },
    });

    assert.equal(text, "A2A Terminal Brief 완료: yukson(4/7)");
    assert.doesNotMatch(text, /업무:/);
  });

  it("renderCompactOperatorNotificationTitle normalizes bare single-worker terminalBriefTitle", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r15-single-worker-bare-title",
      dedupeKey: "r15-single-worker-bare-title",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: sogyo",
      text: "A2A Terminal Brief 완료: sogyo",
      worker: "sogyo",
      roundProgress: { completed: 1 },
      terminalBriefTitle: "A2A Terminal Brief 완료: sogyo",
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "sogyo" },
    });

    assert.equal(text, "A2A Terminal Brief 완료: sogyo(1/1)");
  });

  it("renderCompactOperatorNotificationTitle marks parent-round bare terminalBriefTitle as missing progress", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r15-parent-round-bare-title",
      dedupeKey: "r15-parent-round-bare-title",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: nosuk",
      text: "A2A Terminal Brief 완료: nosuk",
      worker: "nosuk",
      parentRoundId: "team1-terminal-brief-round",
      parentRoundContext: true,
      terminalBriefTitle: "A2A Terminal Brief 완료: nosuk",
      evidence: { schema: "a2a.operator.notification.evidence", version: 1, worker: "nosuk" },
    });

    assert.equal(text, "A2A Terminal Brief 완료: nosuk(완료 ?/?)");
  });

  it("avoids awkward '작업' fallback when terminalBriefTitle is present", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r15-no-awkward",
      dedupeKey: "r15-no-awkward",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "Custom title",
      text: "Custom title\n업무: deploy runner doctor",
      worker: "yukson",
      terminalBriefTitle: "Custom title",
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        worker: "yukson",
        taskDescription: "deploy runner doctor",
      },
    });

    assert.equal(text, "Custom title");
    assert.doesNotMatch(text, /작업/);
    assert.doesNotMatch(text, /업무:/);
  });
});

describe("renderA2AOperatorTerminalBriefTemplate — template rendering (#320)", () => {
  it("renders simple template with title and type variables", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "[{type}] {title}",
      makeTestEnvelope({ type: "success", title: "A2A Terminal Brief 완료: sogyo" }),
    );
    assert.equal(result, "[success] A2A Terminal Brief 완료: sogyo");
  });

  it("renders worker, taskId, and round progress", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "{worker} ({roundNum}/{roundTotal}): {title}",
      makeTestEnvelope({
        type: "success",
        title: "A2A Terminal Brief 완료: sogyo(3/7)",
        worker: "sogyo",
        roundNum: 3,
        roundTotal: 7,
      }),
    );
    assert.equal(result, "sogyo (3/7): A2A Terminal Brief 완료: sogyo(3/7)");
  });

  it("renders repo, issueUrl, and derived issue number", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "{repo} #{issue}: {title}",
      makeTestEnvelope({
        type: "pr",
        title: "A2A Terminal Brief PR",
        repo: "jinwon-int/plugin-a2a",
        issueUrl: "https://github.com/jinwon-int/plugin-a2a/issues/320",
      }),
    );
    assert.equal(result, "jinwon-int/plugin-a2a #320: A2A Terminal Brief PR");
  });

  it("renders prUrl and derived PR number", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "PR #{pr}: {prUrl}",
      makeTestEnvelope({
        type: "pr",
        title: "A2A Terminal Brief PR",
        prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/321",
      }),
    );
    assert.equal(result, "PR #321: https://github.com/jinwon-int/plugin-a2a/pull/321");
  });

  it("renders evidence fields (summary, taskDescription, taskSummary, taskBrief)", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "{summary} | 작업: {taskDescription} | 요약: {taskSummary} | 브리프: {taskBrief}",
      makeTestEnvelope({
        type: "success",
        title: "A2A Terminal Brief 완료: sogyo",
        evidence: {
          schema: "a2a.operator.notification.evidence",
          version: 1,
          worker: "sogyo",
          summary: "Fix login bug",
          taskDescription: "Implement OAuth flow",
          taskSummary: "OAuth integration complete",
          taskBrief: "Broker: seoseo | Worker: sogyo",
        },
      }),
    );
    assert.equal(
      result,
      "Fix login bug | 작업: Implement OAuth flow | 요약: OAuth integration complete | 브리프: Broker: seoseo | Worker: sogyo",
    );
  });

  it("renders doneUrl, blockUrl, runId, traceId, status", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "Run: {runId} | Trace: {traceId} | Status: {status}",
      makeTestEnvelope({
        type: "success",
        title: "A2A Terminal Brief 완료: sogyo",
        doneUrl: "https://github.com/jinwon-int/plugin-a2a/actions/runs/1",
        blockUrl: "https://github.com/jinwon-int/plugin-a2a/issues/2",
        runId: "run-123",
        traceId: "trace-abc",
        status: "completed",
      }),
    );
    assert.equal(
      result,
      "Run: run-123 | Trace: trace-abc | Status: completed",
    );
  });

  it("leaves unknown variables as-is", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "{title} — {unknownVar}",
      makeTestEnvelope({ type: "success", title: "Brief" }),
    );
    assert.equal(result, "Brief — {unknownVar}");
  });

  it("preserves \"use during template string rendering", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "Title: {title}",
      makeTestEnvelope({ type: "success", title: "Release 3.0" }),
    );
    assert.equal(result, "Title: Release 3.0");
  });

  it("leaves undefined optional variables as {var} placeholder", () => {
    const result = renderA2AOperatorTerminalBriefTemplate(
      "{worker}: {title}",
      makeTestEnvelope({ type: "success", title: "A2A Terminal Brief" }),
    );
    // Undefined optional variables are left as-is in the template
    assert.equal(result, "{worker}: A2A Terminal Brief");
  });

  it("works with renderOperatorNotificationText when terminalBriefTemplate is set", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r23-template-test",
      dedupeKey: "r23-template-test",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: sogyo",
      text: "",
      worker: "sogyo",
      repo: "jinwon-int/plugin-a2a",
      issueUrl: "https://github.com/jinwon-int/plugin-a2a/issues/320",
      terminalBriefTemplate: "{repo} #{issue}: {worker} — {title}",
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        worker: "sogyo",
      },
    });
    assert.equal(
      text,
      "jinwon-int/plugin-a2a #320: sogyo — A2A Terminal Brief 완료: sogyo",
    );
  });

  it("falls back to standard rendering when terminalBriefTemplate is absent", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r23-no-template",
      dedupeKey: "r23-no-template",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: sogyo",
      text: "",
      worker: "sogyo",
      roundNum: 1,
      roundTotal: 3,
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        worker: "sogyo",
      },
    });
    assert.match(text, /^A2A Terminal Brief 완료: sogyo\(완료 1\/3\)$/m);
  });
});

// ── Cross-broker/parent-owned relay title preservation ──────────────

describe("cross-broker relay: renderOperatorNotificationText", () => {
  const crossBrokerEnvelope = {
    kind: "a2a.operator.notification" as const,
    version: 1,
    id: "operator-notify:xb-relay-canary",
    dedupeKey: "xb-relay-canary",
    type: "success" as const,
    severity: "info" as const,
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A Terminal Brief 완료: sogyo(완료 4/7)",
    text: "",
    worker: "sogyo",
    terminalBriefTitle: "A2A Terminal Brief 완료: sogyo(완료 4/7)",
    terminalBriefTemplate: "곽가 원문\n{title}\n요약: {summary}",
    parentRoundId: "a2a-cross-broker-round-20260522",
    parentRoundTotal: 7,
    parentRoundOrder: 4,
    evidence: {
      schema: "a2a.operator.notification.evidence",
      version: 1,
      worker: "sogyo",
    },
  };

  it("returns raw terminalBriefTitle when parent-owned and template is set", () => {
    const text = renderOperatorNotificationText(crossBrokerEnvelope);
    assert.equal(
      text,
      "A2A Terminal Brief 완료: sogyo(완료 4/7)",
    );
  });

  it("skips the child-broker terminalBriefTemplate for cross-broker projections", () => {
    const text = renderOperatorNotificationText(crossBrokerEnvelope);
    // The template "곽가 원문\n{title}\n요약: {summary}" would produce
    // "곽가 원문\nA2A Terminal Brief 완료: sogyo(완료 4/7)\n요약: ",
    // but the cross-broker path should return the raw compact title only.
    assert.doesNotMatch(text, /곽가 원문/);
    assert.doesNotMatch(text, /요약/);
  });

  it("still renders template for non-cross-broker envelopes with template", () => {
    const nonCrossBroker = {
      ...crossBrokerEnvelope,
      parentRoundId: undefined,
    };
    const text = renderOperatorNotificationText(nonCrossBroker);
    // Without parentRoundId, the template is rendered normally
    assert.match(text, /곽가 원문/);
  });

  it("falls back to compact title when parent-owned but no template", () => {
    const noTemplate = {
      ...crossBrokerEnvelope,
      terminalBriefTemplate: undefined,
    };
    const text = renderOperatorNotificationText(noTemplate);
    assert.equal(
      text,
      "A2A Terminal Brief 완료: sogyo(완료 4/7)",
    );
  });

  it("renders template when parent-owned but no terminalBriefTitle", () => {
    const noTitle = {
      ...crossBrokerEnvelope,
      terminalBriefTitle: undefined,
    };
    const text = renderOperatorNotificationText(noTitle);
    // Falls through to template rendering since terminalBriefTitle is missing
    assert.match(text, /곽가 원문/);
  });

  it("renders template when parent-owned title is not a compact Terminal Brief title", () => {
    const nonCompactTitle = {
      ...crossBrokerEnvelope,
      title: "Maintenance notice",
      terminalBriefTitle: "Maintenance notice",
    };
    const text = renderOperatorNotificationText(nonCompactTitle);
    assert.match(text, /곽가 원문/);
    assert.match(text, /Maintenance notice/);
  });
});

// ── R25 Missing metadata states ──────────────────────────────────

describe("R25 — missing metadata states", () => {
  it("renders taskId fallback as 1/1 when worker and round progress are absent", () => {
    const outbox = {
      id: "outbox:r25:no-worker",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:00:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:00:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:00:00.000Z",
      },
      payload: {
        taskId: "task-r25-nw",
        status: "succeeded",
        testSummary: "no worker metadata proof",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope for missing worker");
    // Falls back to task-based label when worker is absent
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: task task-r25-nw(1/1)");
    assert.equal(envelope!.worker, undefined);
    assert.equal(envelope!.evidence.worker, undefined);
  });

  it("renders terminal task label as 1/1 when worker, taskId, and round progress are absent", () => {
    const outbox = {
      id: "outbox:r25:no-worker-no-task",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:01:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:01:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:01:00.000Z",
      },
      payload: {
        status: "succeeded",
        repo: "jinwon-int/plugin-a2a",
        issue: 324,
        testSummary: "no worker and no taskId proof",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope for sparse payload");
    // Falls back to A2A label
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: terminal task(1/1)");
  });

  it("evidence fields are gracefully omitted when payload has no summary fields", () => {
    const outbox = {
      id: "outbox:r25:no-summary",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:02:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:02:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:02:00.000Z",
      },
      payload: {
        taskId: "task-r25-ns",
        status: "succeeded",
        worker: "sogyo",
        // No testSummary, no summary, no message, no taskDescription/taskSummary/taskBrief
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope without summary fields");
    assert.equal(envelope!.evidence.summary, undefined, "summary must be undefined when absent");
    assert.equal(envelope!.evidence.taskDescription, undefined);
    assert.equal(envelope!.evidence.taskSummary, undefined);
    assert.equal(envelope!.evidence.taskBrief, undefined);
    // Title still renders correctly without summary
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: sogyo(1/1)");
  });

  it("empty metadata payload still produces valid envelope when receiptProjection exists", () => {
    const payload: Record<string, unknown> = {
      taskId: "task-r25-sparse",
      status: "succeeded",
      worker: "soonwook",
      receiptProjection: "current_session_visible",
      // No repo, no issue, no summary, no round progress
    };

    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r25:sparse",
      data: { terminalEvent: payload },
    });
    assert.ok(envelope, "must produce envelope from minimal terminal event");
    assert.equal(envelope!.worker, "soonwook");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: soonwook(1/1)");
    assert.equal(envelope!.issueUrl, undefined);
    assert.equal(envelope!.repo, undefined);
  });

  it("renderOperatorNotificationText handles envelope with only title and type", () => {
    const text = renderOperatorNotificationText({
      kind: "a2a.operator.notification",
      version: 1,
      id: "operator-notify:r25-bare",
      dedupeKey: "r25-bare",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "A2A Terminal Brief 완료: terminal task",
      text: "",
      evidence: { schema: "a2a.operator.notification.evidence", version: 1 },
    });
    // Even with no worker, repo, issueUrl, the title line is present.
    // renderCompactOperatorNotificationTitle uses envelope.worker as label;
    // when worker is absent, label defaults to "A2A" with standalone 1/1 progress.
    assert.ok(text.length > 0, "text must not be empty");
    assert.match(text, /A2A Terminal Brief 완료: A2A\(1\/1\)/m);
  });
});

// ── R25 Accepted-send / non-ACK states ────────────────────────────

describe("R25 — accepted-send / non-ACK states", () => {
  it("providerAccepted=true alone does NOT produce operator-visible receipt", () => {
    // Payload with providerAccepted=true but no receiptProjection
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r25:provider-accepted",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-r25-pa",
          worker: "soonwook",
          providerAccepted: true,
          summary: "provider accepted send but no operator receipt",
          // No receiptProjection — provider accepted is not operator receipt
        },
      },
    });

    // Without receiptProjection, the function must NOT produce an envelope
    assert.equal(envelope, undefined, "providerAccepted alone must not produce operator envelope");
  });

  it("status='accepted' alone does NOT produce operator-visible receipt", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r25:status-accepted",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-r25-sa",
          worker: "soonwook",
          status: "accepted",
          summary: "status accepted but no operator receipt",
          // No receiptProjection — status 'accepted' is not operator receipt
        },
      },
    });

    assert.equal(envelope, undefined, "accepted status alone must not produce operator envelope");
  });

  it("provider_accepted_send status alone does NOT produce operator-visible receipt", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r25:provider-accepted-send",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-r25-pas",
          worker: "soonwook",
          status: "provider_accepted_send",
          summary: "provider accepted send",
          // No receiptProjection — provider accepted send is not operator receipt
        },
      },
    });

    assert.equal(envelope, undefined, "provider_accepted_send alone must not produce operator envelope");
  });

  it("explicit receiptProjection:current_session_visible produces envelope even when providerAccepted=true also present", () => {
    // When BOTH providerAccepted and receiptProjection exist, receiptProjection wins
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r25:mixed",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-r25-mixed",
          worker: "soonwook",
          providerAccepted: true,
          receiptProjection: "current_session_visible",
          summary: "provider accepted plus operator receipt",
        },
      },
    });

    // receiptProjection must take precedence — envelope MUST be produced
    assert.ok(envelope, "receiptProjection must produce envelope even with providerAccepted");
    assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
  });

  it("outbox with accepted receipt status but no receiptProjection yields undefined (receipt gate)", () => {
    // Terminal outbox with receipt.status='accepted' but no operator_visible evidence
    // The receipt gate requires receiptProjection — provider accepted alone is NOT operator ACK
    const outbox = {
      id: "outbox:r25:accepted-only",
      kind: "task.terminal" as const,
      attempts: 1,
      createdAt: "2026-05-15T07:10:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:10:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "provider accepted only — not operator-visible receipt; no ACK yet",
        updatedAt: "2026-05-15T07:10:00.000Z",
      },
      payload: {
        taskId: "task-r25-rc-ack",
        status: "succeeded",
        worker: "soonwook",
        repo: "jinwon-int/plugin-a2a",
        issue: 324,
        testSummary: "accepted receipt but no operator ACK",
        // No receiptProjection — outbox builder gates on this
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    // Provider accepted alone must NOT produce envelope — this is the receipt gate
    assert.equal(envelope, undefined, "provider accepted alone must not produce envelope (receipt gate)");
  });

  it("outbox with receiptProjection produces envelope with pending ackAudit (non-ACK)", () => {
    const outbox = {
      id: "outbox:r25:with-projection",
      kind: "task.terminal" as const,
      attempts: 1,
      createdAt: "2026-05-15T07:11:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:11:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "projection received but ACK still pending — not operator confirmed",
        updatedAt: "2026-05-15T07:11:00.000Z",
      },
      payload: {
        taskId: "task-r25-ack-pending",
        status: "succeeded",
        worker: "soonwook",
        repo: "jinwon-int/plugin-a2a",
        issue: 324,
        testSummary: "receipt projection present but ACK still pending",
        receiptProjection: "current_session_visible",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "outbox with receiptProjection must produce envelope");
    assert.equal(envelope!.type, "success");
    assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
    // The ackAudit decision is pending — this proves receiptProjection != ACK
    assert.equal(outbox.ackAudit.decision, "pending");
  });
});

// ── R25 Team2 runId/parentIssueUrl dispatch shapes ────────────────

describe("R25 — Team2 runId/parentIssueUrl dispatch shapes", () => {
  it("Team2 runId preserved through outbox envelope", () => {
    const outbox = {
      id: "outbox:team2:runId",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:15:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:15:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:15:00.000Z",
      },
      payload: {
        taskId: "task-team2-r25",
        status: "succeeded",
        worker: "soonwook",
        repo: "jinwon-int/plugin-a2a",
        issue: 324,
        runId: "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
        testSummary: "Team2 runId preserved",
        completedAt: "2026-05-15T07:15:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope with Team2 runId");
    assert.equal(
      envelope!.runId,
      "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
    );
    assert.equal(
      envelope!.evidence.runId,
      "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
    );
  });

  it("Team2 parentIssueUrl mapped to issueUrl in envelope", () => {
    const outbox = {
      id: "outbox:team2:parentIssueUrl",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:16:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:16:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:16:00.000Z",
      },
      payload: {
        taskId: "task-team2-piu",
        status: "succeeded",
        worker: "soonwook",
        repo: "a2a-plane (internal tracker, private)",
        runId: "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
        // Team2's parentIssueUrl field for the parent lane issue
        parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/350",
        testSummary: "Team2 parentIssueUrl mapped to issueUrl",
        completedAt: "2026-05-15T07:16:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope with Team2 parentIssueUrl");
    // parentIssueUrl should be picked up by readIssueUrl and mapped to issueUrl
    assert.equal(
      envelope!.issueUrl,
      "https://github.com/jinwon-int/a2a-nexus/issues/350",
    );
    assert.equal(
      envelope!.evidence.issueUrl,
      "https://github.com/jinwon-int/a2a-nexus/issues/350",
    );
    // runId also preserved
    assert.equal(
      envelope!.runId,
      "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
    );
  });

  it("Team2 live-terminal payload with runId and parentIssueUrl", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:team2:dispatch",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-team2-live",
          worker: "soonwook",
          repo: "a2a-plane (internal tracker, private)",
          runId: "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
          parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/350",
          receiptProjection: "current_session_visible",
          summary: "Team2 live dispatch with runId and parentIssueUrl",
          completedAt: "2026-05-15T07:17:00.000Z",
        },
      },
    });

    assert.ok(envelope, "must produce envelope from Team2 live-terminal payload");
    assert.equal(envelope!.worker, "soonwook");
    assert.equal(
      envelope!.runId,
      "a2a-r25-team2-terminal-brief-implementation-20260515T075717Z",
    );
    assert.equal(
      envelope!.issueUrl,
      "https://github.com/jinwon-int/a2a-nexus/issues/350",
    );
  });

  it("Team2 parent_issue_url (snake_case) also maps to issueUrl", () => {
    const outbox = {
      id: "outbox:team2:snake",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:18:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:18:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:18:00.000Z",
      },
      payload: {
        taskId: "task-team2-snake",
        status: "succeeded",
        worker: "soonwook",
        repo: "jinwon-int/plugin-a2a",
        runId: "a2a-r25-team2-terminal-brief-snake-20260515",
        parent_issue_url: "https://github.com/jinwon-int/plugin-a2a/issues/324",
        testSummary: "Team2 snake_case parent_issue_url",
        completedAt: "2026-05-15T07:18:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope with parent_issue_url");
    assert.equal(
      envelope!.issueUrl,
      "https://github.com/jinwon-int/plugin-a2a/issues/324",
    );
    // runId also preserved
    assert.equal(
      envelope!.runId,
      "a2a-r25-team2-terminal-brief-snake-20260515",
    );
  });
});

// ── R25 Cross-broker projection shapes with Team2 metadata ──────────

describe("R25 — cross-broker projection shapes with Team2 metadata", () => {
  it("cross-broker outbox with Team2 runId and parentIssueUrl produces envelope", () => {
    const outbox = {
      id: "outbox:cross:team2",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:20:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:20:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "cross-broker projection; awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:20:00.000Z",
      },
      payload: {
        taskId: "task-team2-cross",
        status: "succeeded",
        worker: "soonwook",
        repo: "a2a-plane (internal tracker, private)",
        runId: "a2a-r25-team2-cross-broker-20260515T075717Z",
        parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/350",
        testSummary: "Team2 cross-broker projection with runId and parentIssueUrl",
        crossBrokerHandoff: {
          parentRoundId: "parent-team2-r25",
          originBrokerId: "soonwook-vps",
          handoffBrokerId: "broker-racknerd-167be94",
          originTaskId: "task-team2-cross",
        },
        completedAt: "2026-05-15T07:20:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope for cross-broker Team2 outbox");
    assert.equal(envelope!.worker, "soonwook");
    assert.equal(
      envelope!.runId,
      "a2a-r25-team2-cross-broker-20260515T075717Z",
    );
    assert.equal(
      envelope!.issueUrl,
      "https://github.com/jinwon-int/a2a-nexus/issues/350",
    );
    assert.equal(envelope!.type, "success");
  });

  it("cross-broker live-terminal event with Team2 metadata produces envelope", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:cross:team2",
      data: {
        terminalEvent: {
          type: "succeeded",
          taskId: "task-team2-cross-live",
          worker: "soonwook",
          repo: "a2a-plane (internal tracker, private)",
          runId: "a2a-r25-team2-cross-live-20260515T075717Z",
          parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/350",
          receiptProjection: "current_session_visible",
          summary: "cross-broker live with Team2 runId and parentIssueUrl",
          crossBrokerHandoff: {
            parentRoundId: "parent-team2-r25-live",
            originBrokerId: "soonwook-vps",
            handoffBrokerId: "broker-racknerd-167be94",
            originTaskId: "task-team2-cross-live",
          },
          completedAt: "2026-05-15T07:21:00.000Z",
        },
      },
    });

    assert.ok(envelope, "must produce envelope for cross-broker live Team2 event");
    assert.equal(envelope!.worker, "soonwook");
    assert.equal(
      envelope!.runId,
      "a2a-r25-team2-cross-live-20260515T075717Z",
    );
    assert.equal(
      envelope!.issueUrl,
      "https://github.com/jinwon-int/a2a-nexus/issues/350",
    );
  });

  it("cross-broker outbox with team2 runId and no issueUrl gracefully defaults", () => {
    // Team2 payload with runId but NO issue URL — must still produce envelope
    const outbox = {
      id: "outbox:cross:team2-no-issue",
      kind: "task.terminal" as const,
      attempts: 0,
      createdAt: "2026-05-15T07:22:00.000Z",
      receipt: { status: "accepted", updatedAt: "2026-05-15T07:22:00.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "cross-broker projection; awaiting current-session-visible evidence before ACK",
        updatedAt: "2026-05-15T07:22:00.000Z",
      },
      payload: {
        taskId: "task-team2-no-issue",
        status: "succeeded",
        worker: "soonwook",
        repo: "a2a-plane (internal tracker, private)",
        runId: "a2a-r25-cross-no-issue-20260515",
        testSummary: "cross-broker with runId only, no parent issue URL",
        crossBrokerHandoff: {
          parentRoundId: "parent-team2-no-issue",
          originBrokerId: "soonwook-vps",
          handoffBrokerId: "broker-racknerd-167be94",
          originTaskId: "task-team2-no-issue",
        },
        completedAt: "2026-05-15T07:22:00.000Z",
      },
    };

    const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
    assert.ok(envelope, "must produce envelope without issueUrl");
    assert.equal(envelope!.worker, "soonwook");
    assert.equal(
      envelope!.runId,
      "a2a-r25-cross-no-issue-20260515",
    );
    // issueUrl is gracefully omitted when no parentIssueUrl or issueUrl exists
    assert.equal(envelope!.issueUrl, undefined);
  });
});

describe("R26 — nested Terminal Brief metadata extraction", () => {
  it("uses nested task.payload terminalBriefTitle and parentRoundProgress for live events", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r26:nested-task-payload",
      data: {
        terminalEvent: {
          type: "succeeded",
          task: {
            id: "task-r26-nested",
            payload: {
              worker: "runner-node",
              parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/350",
              terminalBriefTitle: "A2A Terminal Brief 완료: dungae(1/3)",
              parentRoundProgress: 1,
              parentRoundTotal: 3,
              terminalBrief: {
                workerLabel: "dungae",
                summary: "human Terminal Brief summary",
              },
            },
          },
          receiptProjection: "current_session_visible",
          summary: "docker runner completed task-r26-nested",
        },
      },
    });

    assert.ok(envelope, "must produce envelope from nested task payload");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: dungae(1/3)");
    assert.equal(envelope!.terminalBriefTitle, "A2A Terminal Brief 완료: dungae(1/3)");
    assert.equal(envelope!.worker, "dungae");
    assert.equal(envelope!.roundNum, 1);
    assert.equal(envelope!.roundTotal, 3);
    assert.equal(envelope!.issueUrl, "https://github.com/jinwon-int/a2a-nexus/issues/350");
  });

  it("prefers crossBrokerHandoff.childWorkerId over handoff broker worker label", () => {
    const envelope = buildA2AOperatorTerminalNotificationEnvelope({
      id: "live:r26:child-worker",
      data: {
        terminalEvent: {
          type: "succeeded",
          worker: "gwakga",
          parentRoundProgress: 2,
          parentRoundTotal: 3,
          receiptProjection: "current_session_visible",
          crossBrokerHandoff: {
            parentRoundId: "round-r26",
            originBrokerId: "seoseo",
            handoffBrokerId: "gwakga",
            childWorkerId: "dungae",
          },
        },
      },
    });

    assert.ok(envelope, "must produce cross-broker envelope");
    assert.equal(envelope!.worker, "dungae");
    assert.equal(envelope!.title, "A2A Terminal Brief 완료: dungae(완료 2/3)");
  });
});

function makeTestEnvelope(
  overrides: Partial<import("../dist/src/operator-terminal-notifier.js").A2AOperatorTerminalNotificationEnvelope> = {},
): import("../dist/src/operator-terminal-notifier.js").A2AOperatorTerminalNotificationEnvelope {
  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: "test-id",
    dedupeKey: "test-dedup",
    type: overrides.type ?? "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: overrides.title ?? "A2A Terminal Brief",
    text: overrides.text ?? "",
    evidence: overrides.evidence ?? {
      schema: "a2a.operator.notification.evidence",
      version: 1,
      worker: "unknown",
    },
    ...overrides,
  };
}

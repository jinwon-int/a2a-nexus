import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createA2ATerminalBriefSidecar,
  createCommandNotificationHandler,
  createMemoryTerminalBriefSidecarCursorStore,
  normalizeA2ATerminalBriefSidecarConfig,
} from "../dist/src/terminal-brief-sidecar.js";
import type { A2ATerminalOutboxEvent } from "../dist/standalone-broker-client.js";

function terminalEvent(id: string): A2ATerminalOutboxEvent {
  return {
    id,
    type: "terminal.brief",
    status: "succeeded",
    createdAt: "2026-05-18T04:00:00.000Z",
    updatedAt: "2026-05-18T04:00:00.000Z",
    attempts: 0,
    payload: {
      taskId: "terminal-brief-sidecar-canary",
      status: "succeeded",
      worker: "sogyo",
      completedAt: "2026-05-18T04:00:00.000Z",
      summary: "sidecar canary completed",
      parentRoundProgress: 1,
      parentRoundTotal: 1,
    },
    receipt: { status: "accepted", updatedAt: "2026-05-18T04:00:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "awaiting current-session-visible evidence before ACK",
      updatedAt: "2026-05-18T04:00:00.000Z",
      worker: "sogyo",
      receiptStatus: "accepted",
    },
    ack: null,
    deliveredAt: null,
  } as A2ATerminalOutboxEvent;
}

async function* emptyOperatorStream() {
  // Sidecar tests exercise terminal-outbox polling without Gateway operatorEvents.
}

describe("Terminal Brief sidecar", () => {
  it("defaults to dry-run, no Gateway operatorEvents requirement, and suppressed replay", () => {
    const config = normalizeA2ATerminalBriefSidecarConfig({
      baseUrl: "http://127.0.0.1:8787",
    });

    assert.equal(config.deliveryMode, "dry-run");
    assert.equal(config.operatorEventStreamEnabled, false);
    assert.equal(config.terminalOutboxHistoricalReplay, "suppress");
    assert.equal(config.terminalEventHistoricalReplay, "suppress");
    assert.equal(config.terminalOutboxReconcileUnackedOnStart, false);
  });

  it("dry-run renders Terminal Brief without provider send or terminal ACK", async () => {
    const event = terminalEvent("terminal:sidecar-dry-run:succeeded:2026-05-18T04%3A00%3A00.000Z");
    const listedParams: unknown[] = [];
    const acked: unknown[] = [];
    const cursorStore = createMemoryTerminalBriefSidecarCursorStore({
      terminalOutboxCursor: "terminal:before",
    });

    const sidecar = createA2ATerminalBriefSidecar({
      baseUrl: "http://broker.example.test",
      terminalOutboxAllowedIds: ["terminal:sidecar-dry-run"],
      terminalOutboxPollMs: 1,
      terminalOutboxLimit: 5,
    }, {
      cursorStore,
      now: () => Date.parse("2026-05-18T03:59:59.000Z"),
      waitForRetry: async () => {
        throw new Error("stop test loop");
      },
      broker: {
        async *streamOperatorEvents() {
          yield* emptyOperatorStream();
        },
        async listTerminalOutbox(params) {
          listedParams.push(params);
          return { events: [event], cursor: event.id };
        },
        async ackTerminalOutbox(params) {
          acked.push(params);
          return event;
        },
      },
    });

    const initial = sidecar.start();
    await sidecar.waitForIdle();
    const status = sidecar.getStatus();
    sidecar.shutdown();

    assert.equal(initial.gatewayOperatorEventsRequired, false);
    assert.equal(initial.openClawGatewayEventLoopShared, false);
    assert.equal(listedParams.length, 1);
    assert.deepEqual(listedParams[0], {
      afterId: "terminal:before",
      reconcileUnacked: false,
      limit: 5,
    });
    assert.equal(sidecar.listDryRunNotifications().length, 1);
    assert.equal(sidecar.listDryRunNotifications()[0].dryRun, true);
    assert.equal(acked.length, 0, "dry-run sidecar must not ACK production terminal outbox rows");
    assert.equal(status.terminalOutbox.cursor, "terminal:before", "failed dry-run receipt holds cursor for review");
  });

  it("keeps dry-run delivery even when an external notifier dependency is present", async () => {
    const event = terminalEvent("terminal:sidecar-dry-run-guard:succeeded:2026-05-18T04%3A00%3A00.000Z");
    let liveNotifierCalls = 0;
    let ackCalls = 0;

    const sidecar = createA2ATerminalBriefSidecar({
      baseUrl: "http://broker.example.test",
      deliveryMode: "dry-run",
      terminalOutboxAllowedIds: ["terminal:sidecar-dry-run-guard"],
      terminalOutboxPollMs: 1,
    }, {
      now: () => Date.parse("2026-05-18T03:59:59.000Z"),
      waitForRetry: async () => {
        throw new Error("stop test loop");
      },
      notifyOperator: async () => {
        liveNotifierCalls += 1;
        return {
          ackTerminalEvent: true,
          confirmationSource: "current_session_visible",
          reason: "must not be used in dry-run mode",
        };
      },
      broker: {
        async *streamOperatorEvents() {
          yield* emptyOperatorStream();
        },
        async listTerminalOutbox() {
          return { events: [event], cursor: event.id };
        },
        async ackTerminalOutbox() {
          ackCalls += 1;
          return event;
        },
      },
    });

    sidecar.start();
    await sidecar.waitForIdle();
    sidecar.shutdown();

    assert.equal(liveNotifierCalls, 0, "dry-run mode must not call an injected live notifier");
    assert.equal(ackCalls, 0, "dry-run mode must not ACK terminal outbox rows");
    assert.equal(sidecar.listDryRunNotifications().length, 1);
  });

  it("external notifier ACKs only after current-session visible receipt and persists cursor", async () => {
    const event = terminalEvent("terminal:sidecar-live:succeeded:2026-05-18T04%3A00%3A00.000Z");
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-sidecar-"));
    const cursorFile = join(tempDir, "cursor.json");
    const acked: unknown[] = [];
    try {
      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        cursorFile,
        terminalOutboxCursor: "terminal:before",
        terminalOutboxAllowedIds: ["terminal:sidecar-live"],
        terminalOutboxPollMs: 1,
        deliveryMode: "external",
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        notifyOperator: async () => ({
          ackTerminalEvent: true,
          confirmationSource: "current_session_visible",
          receiptId: "telegram:message:sidecar-live",
          reason: "test visible receipt",
        }),
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [event], cursor: event.id };
          },
          async ackTerminalOutbox(params) {
            acked.push(params);
            return {
              ...event,
              ack: {
                status: "receipt_confirmed",
                evidence: params.receipt.evidence,
                updatedAt: params.receipt.acknowledgedAt,
              },
            } as A2ATerminalOutboxEvent;
          },
        },
      });

      sidecar.start();
      await sidecar.waitForIdle();
      const status = sidecar.getStatus();
      sidecar.shutdown();

      assert.equal(acked.length, 1);
      assert.deepEqual(acked[0], {
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt: "2026-05-18T03:59:59.000Z",
          receiptId: "telegram:message:sidecar-live",
          note: "test visible receipt",
        },
      });
      assert.equal(status.terminalOutbox.cursor, event.id);
      assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).terminalOutboxCursor, event.id);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("external spool-only notifier records produced receipt and advances cursor without ACK", async () => {
    const event = terminalEvent("terminal:sidecar-spool-produced:succeeded:2026-05-18T04%3A00%3A00.000Z");
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-sidecar-spool-"));
    const cursorFile = join(tempDir, "cursor.json");
    const receipts: unknown[] = [];
    let ackCalls = 0;

    try {
      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        cursorFile,
        terminalOutboxCursor: "terminal:before",
        terminalOutboxAllowedIds: ["terminal:sidecar-spool-produced"],
        terminalOutboxPollMs: 1,
        deliveryMode: "external",
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        notifyOperator: async () => ({
          ackTerminalEvent: false,
          terminalReceiptStatus: "produced",
          receiptId: "spool:gongyung:sidecar-produced",
          reason: "Gongyung spool record produced; terminal ACK remains pending",
        }),
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [event], cursor: event.id };
          },
          async ackTerminalOutbox() {
            ackCalls += 1;
            return event;
          },
          async recordTerminalOutboxReceipt(params) {
            receipts.push(params);
            return {
              ...event,
              receipt: {
                status: params.receipt.status,
                updatedAt: params.receipt.updatedAt,
                note: params.receipt.note,
              },
            } as A2ATerminalOutboxEvent;
          },
        },
      });

      sidecar.start();
      await sidecar.waitForIdle();
      const status = sidecar.getStatus();
      sidecar.shutdown();

      assert.equal(ackCalls, 0, "spool-only receipt must not ACK terminal outbox rows");
      assert.deepEqual(receipts, [{
        id: event.id,
        receipt: {
          status: "produced",
          updatedAt: "2026-05-18T03:59:59.000Z",
          note: "Gongyung spool record produced; terminal ACK remains pending",
        },
      }]);
      assert.equal(status.terminalOutbox.cursor, event.id);
      assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).terminalOutboxCursor, event.id);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("delivery command fails closed on provider-only receipt decisions", async () => {
    const event = terminalEvent("terminal:sidecar-provider-only:succeeded:2026-05-18T04%3A00%3A00.000Z");
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-sidecar-command-"));
    const command = join(tempDir, "provider-only-notifier.mjs");
    let ackCalls = 0;

    try {
      writeFileSync(command, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  ackTerminalEvent: true,",
        "  confirmationSource: 'provider_accepted',",
        "  receiptId: 'telegram:message:provider-only',",
        "  reason: 'provider accepted'",
        "}));",
      ].join("\n"));
      chmodSync(command, 0o755);

      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        terminalOutboxCursor: "terminal:before",
        terminalOutboxAllowedIds: ["terminal:sidecar-provider-only"],
        terminalOutboxPollMs: 1,
        deliveryMode: "external",
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        notifyOperator: createCommandNotificationHandler({ command }),
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [event], cursor: event.id };
          },
          async ackTerminalOutbox() {
            ackCalls += 1;
            return event;
          },
        },
      });

      sidecar.start();
      await sidecar.waitForIdle();
      const status = sidecar.getStatus();
      sidecar.shutdown();

      assert.equal(ackCalls, 0, "provider-only receipt decisions must not ACK terminal outbox rows");
      assert.equal(status.terminalOutbox.cursor, "terminal:before", "failed receipt keeps cursor replayable");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── Doctor report tests ────────────────────────────────────

  describe("doctor report — no-live diagnostic surface", () => {
    it("reports basic structure when sidecar has not polled", () => {
      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        terminalOutboxPollMs: 1000,
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [], cursor: "terminal:latest" };
          },
        },
      });

      const report = sidecar.doctor();
      sidecar.shutdown();

      assert.equal(report.kind, "a2a.terminalBrief.sidecar.doctorReport");
      assert.ok(report.recordedAt, "doctor report must include recordedAt timestamp");
      assert.ok(Array.isArray(report.staleRows), "staleRows must be an array");
      assert.ok(report.duplicateSuppression, "duplicateSuppression must be present");
      assert.equal(report.dryRunNotifications, 0, "no dry-run notifications before poll");
    });

    it("reports cursor state from cursor store", () => {
      const cursorStore = createMemoryTerminalBriefSidecarCursorStore({
        operatorCursor: "operator:42",
        terminalOutboxCursor: "terminal:latest",
      });

      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        terminalOutboxPollMs: 1000,
      }, {
        cursorStore,
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [], cursor: "terminal:latest" };
          },
        },
      });

      const report = sidecar.doctor();
      sidecar.shutdown();

      assert.equal(report.cursorState.operatorCursor, "operator:42");
      assert.equal(report.cursorState.terminalOutboxCursor, "terminal:latest");
    });

    it("reports last operator-visible ACK evidence when bridge has been populated", async () => {
      const event = terminalEvent("terminal:sidecar-doctor-ack:succeeded:2026-05-18T04%3A00%3A00.000Z");
      const acked: unknown[] = [];

      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        terminalOutboxCursor: "terminal:before",
        terminalOutboxAllowedIds: ["terminal:sidecar-doctor-ack"],
        terminalOutboxPollMs: 1,
        deliveryMode: "external",
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        notifyOperator: async () => ({
          ackTerminalEvent: true,
          confirmationSource: "current_session_visible",
          receiptId: "telegram:message:doctor-ack",
          reason: "test doctor ACK evidence",
        }),
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [event], cursor: event.id };
          },
          async ackTerminalOutbox(params) {
            acked.push(params);
            return {
              ...event,
              ack: {
                status: "receipt_confirmed",
                evidence: params.receipt.evidence,
                updatedAt: params.receipt.acknowledgedAt,
              },
            } as A2ATerminalOutboxEvent;
          },
        },
      });

      sidecar.start();
      await sidecar.waitForIdle();
      const report = sidecar.doctor();
      sidecar.shutdown();

      assert.ok(report.lastOperatorVisibleAck, "doctor must expose last operator-visible ACK evidence");
      assert.equal(report.lastOperatorVisibleAck!.evidence, "operator_visible");
      assert.equal(report.lastOperatorVisibleAck!.id, event.id);
      assert.equal(acked.length, 1, "ACK must have been sent to broker");
    });

    it("reports duplicate suppression diagnostics from bridge state", async () => {
      const event = terminalEvent("terminal:sidecar-doctor-dedupe:succeeded:2026-05-18T04%3A00%3A00.000Z");

      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
        terminalOutboxCursor: "terminal:before",
        terminalOutboxAllowedIds: ["terminal:sidecar-doctor-dedupe"],
        terminalOutboxPollMs: 1,
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [event], cursor: event.id };
          },
        },
      });

      sidecar.start();
      await sidecar.waitForIdle();
      const report = sidecar.doctor();
      sidecar.shutdown();

      assert.ok(report.duplicateSuppression.doctorDiagnostics, "duplicateSuppression must include doctor diagnostics");
      assert.equal(typeof report.duplicateSuppression.doctorDiagnostics!.notificationFuseTripped, "boolean");
      assert.equal(typeof report.duplicateSuppression.doctorDiagnostics!.notifiedDedupeKeyCount, "number");
    });

    it("reports safety status in doctor output", () => {
      const sidecar = createA2ATerminalBriefSidecar({
        baseUrl: "http://broker.example.test",
      }, {
        now: () => Date.parse("2026-05-18T03:59:59.000Z"),
        waitForRetry: async () => {
          throw new Error("stop test loop");
        },
        broker: {
          async *streamOperatorEvents() {
            yield* emptyOperatorStream();
          },
          async listTerminalOutbox() {
            return { events: [], cursor: "terminal:latest" };
          },
        },
      });

      const report = sidecar.doctor();
      sidecar.shutdown();

      assert.ok(report.safety, "doctor must include safety status");
      assert.equal(report.safety.liveSendRequiresExternalNotifier, true, "doctor safety must include liveSendRequiresExternalNotifier");
    });
  });
});

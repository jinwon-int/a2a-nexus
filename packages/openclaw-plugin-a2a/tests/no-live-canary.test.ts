/**
 * No-live canary harness for the plugin/broker public A2A seam (#247).
 *
 * Parent: a2a-plane#174 (internal tracker, private)
 * Issue:  jinwon-int/plugin-a2a#247
 * Run:    a2a-live-canary-readiness-20260509T173917Z
 *
 * Exercises the receipt-runtime boundary that separates:
 *   1. Notification disabled → no send possible
 *   2. Provider accepted-send → distinct from operator-visible receipt
 *   3. Operator-visible receipt → required for ACK eligibility
 *   4. ACK eligibility → gated on operator-visible receipt only (never
 *      provider accepted alone)
 *
 * This test does NOT send live messages, does NOT restart Gateway, and
 * does NOT ACK terminal outbox records. All operations are fail-closed
 * and use only in-process dry-run harness fixtures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildA2AOperatorTerminalNotificationEnvelope,
  buildA2AOperatorTerminalOutboxNotificationEnvelope,
  createA2ATelegramSafeDryRunNotificationHarness,
  getA2AOperatorTerminalOutboxReceiptGap,
  getA2AOperatorTerminalReceiptGate,
  buildA2AOpenClawTelegramOperatorNotification,
  type A2AOperatorTerminalNotificationEnvelope,
} from "../dist/src/operator-terminal-notifier.js";
import {
  createA2AOperatorNotificationAdapter,
  resolveOperatorNotificationTarget,
  preflightA2AOperatorNotificationRuntime,
} from "../dist/src/operator-notification-adapter.js";

// ── Canary fixture builders ──────────────────────────────────────

function buildTerminalEventPayload(overrides: Record<string, unknown>) {
  return {
    id: "canary-event-1",
    name: "terminal-brief",
    data: {
      terminalEvent: {
        type: "success",
        taskId: "task-canary-1",
        worker: "workerBeta",
        repo: "jinwon-int/plugin-a2a",
        issue: 247,
        runId: "a2a-live-canary-readiness-20260509T173917Z",
        receiptProjection: "current_session_visible",
        summary: "no-live canary harness smoke",
        ...overrides,
      },
    },
  };
}

function buildOperatorReceiptEvent(projection: string) {
  return buildTerminalEventPayload({
    receiptProjection: projection,
    summary: `${projection} receipt test`,
  });
}

function buildProviderAcceptedOnlyEvent() {
  return {
    id: "canary-provider-accepted",
    name: "terminal-brief",
    data: {
      terminalEvent: {
        type: "success",
        taskId: "task-provider-accepted-1",
        worker: "workerBeta",
        repo: "jinwon-int/plugin-a2a",
        issue: 247,
        runId: "a2a-live-canary-readiness-20260509T173917Z",
        summary: "provider accepted but no operator receipt",
        // projection missing entirely — provider acceptance only
      },
    },
  };
}

function buildProviderAcceptedOnlyOutbox() {
  return {
    id: "outbox-canary-provider-accepted",
    payload: {
      type: "success",
      taskId: "task-provider-outbox-1",
      worker: "workerBeta",
      repo: "jinwon-int/plugin-a2a",
      issue: 249,
      completedAt: "2026-05-10T03:00:00Z",
      summary: "outbox record with no receipt projection",
      // receiptProjection missing entirely — provider acceptance only
    },
    createdAt: "2026-05-10T03:00:01Z",
  };
}

function configWithNotificationDisabled() {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: false,
            },
          },
        },
      },
    },
  };
}

function configWithNotificationEnabled() {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: {
                enabled: true,
                channel: "telegram",
                to: "operator-chat",
              },
            },
          },
        },
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("no-live canary harness (#247)", () => {
  describe("notification disabled → no send", () => {
    it("dry-run harness never sends live Telegram messages", () => {
      const harness = createA2ATelegramSafeDryRunNotificationHarness({
        maxNotifications: 10,
      });

      const event = buildOperatorReceiptEvent("current_session_visible");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope, "envelope must build for valid receipt projection");

      harness.notify(envelope!);
      const stats = harness.stats();

      assert.equal(stats.accepted, 1);
      assert.equal(stats.dropped, 0);
      assert.ok(stats.maxNotifications > 0, "harness must have positive capacity");

      // Verify envelopes are marked dryRun
      const listed = harness.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].dryRun, true);
    });

    it("dry-run harness mirrors envelopes into Telegram projection without sending", () => {
      const harness = createA2ATelegramSafeDryRunNotificationHarness({
        maxNotifications: 20,
      });

      for (let i = 0; i < 5; i += 1) {
        const event = buildTerminalEventPayload({
          type: "success",
          taskId: `task-canary-${i}`,
          receiptProjection: "current_session_visible",
          summary: `canary iteration ${i}`,
        });
        const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
        assert.ok(envelope);
        harness.notify(envelope!);
      }

      const stats = harness.stats();
      assert.equal(stats.accepted, 5);
      assert.equal(stats.dropped, 0);

      const telegramList = harness.listTelegram();
      assert.equal(telegramList.length, 5);
      for (const notification of telegramList) {
        assert.equal(notification.kind, "openclaw.operator.telegram_notification");
        assert.equal(notification.delivery.mode, "announce");
        assert.equal(notification.delivery.channel, "telegram");
        assert.equal(notification.dryRun, true);
        assert.ok(notification.dedupeKey, "telegram projection must carry dedupe key");
      }
    });

    it("drops notifications beyond capacity without sending", () => {
      const harness = createA2ATelegramSafeDryRunNotificationHarness({
        maxNotifications: 3,
      });

      for (let i = 0; i < 6; i += 1) {
        const event = buildTerminalEventPayload({
          type: "success",
          taskId: `task-canary-${i}`,
          receiptProjection: "current_session_visible",
          summary: `capacity test ${i}`,
        });
        const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
        assert.ok(envelope);
        harness.notify(envelope!);
      }

      const stats = harness.stats();
      assert.equal(stats.accepted, 3);
      assert.equal(stats.dropped, 3);
      assert.equal(harness.list().length, 3);
      assert.equal(harness.listTelegram().length, 3);
    });

    it("notification adapter returns undefined when notification is disabled", () => {
      const adapter = createA2AOperatorNotificationAdapter(
        configWithNotificationDisabled(),
        undefined,
      );
      assert.equal(adapter, undefined);
    });

    it("preflight blocks when notification is disabled", async () => {
      const result = await preflightA2AOperatorNotificationRuntime(
        configWithNotificationDisabled(),
        undefined,
      );
      assert.equal(result.ok, false);
      assert.equal(result.safeToRestartGateway, false);
      assert.deepEqual(result.notificationTarget.status, "blocked" as const);
      assert.equal(
        result.checks.some((c) => c.code === "notification_target" && !c.ok),
        true,
      );
    });

    it("resolveOperatorNotificationTarget returns undefined when disabled", () => {
      const target = resolveOperatorNotificationTarget(
        configWithNotificationDisabled(),
      );
      assert.equal(target, undefined);
    });
  });

  describe("provider accepted-send ≠ operator-visible receipt", () => {
    it("rejects receipt projection that is not current_session_visible or manual_operator_receipt", () => {
      // provider_send_success is not a valid projection
      const event = buildOperatorReceiptEvent("provider_send_success");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.equal(envelope, undefined);
    });

    it("rejects empty projection (provider accepted only, no receipt)", () => {
      const event = buildProviderAcceptedOnlyEvent();
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.equal(envelope, undefined);
    });

    it("rejects unknown projection strings", () => {
      for (const projection of [
        "send_ok",
        "provider_ok",
        "delivery_sent",
        "message_queued",
        "",
      ]) {
        const event = buildOperatorReceiptEvent(projection);
        const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
        assert.equal(
          envelope,
          undefined,
          `projection "${projection}" must not produce an envelope`,
        );
      }
    });

    it("getA2AOperatorTerminalReceiptGate returns isTerminal=true without receiptProjection for provider-accepted-only events", () => {
      const event = buildProviderAcceptedOnlyEvent();
      const gate = getA2AOperatorTerminalReceiptGate(event);
      assert.equal(gate.isTerminal, true);
      assert.equal(
        gate.receiptProjection,
        undefined,
        "provider-accepted-only event must not carry a receipt projection",
      );
    });

    it("getA2AOperatorTerminalReceiptGate returns receiptProjection for operator-visible events", () => {
      const event = buildOperatorReceiptEvent("current_session_visible");
      const gate = getA2AOperatorTerminalReceiptGate(event);
      assert.equal(gate.isTerminal, true);
      assert.equal(gate.receiptProjection, "current_session_visible");
    });
  });

  describe("operator-visible receipt required for ACK eligibility", () => {
    it("current_session_visible produces a notification envelope", () => {
      const event = buildOperatorReceiptEvent("current_session_visible");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
    });

    it("manual_operator_receipt produces a notification envelope", () => {
      const event = buildOperatorReceiptEvent("manual_operator_receipt");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.evidence.receiptProjection, "manual_operator_receipt");
    });

    it("operator notification adapter resolves target when notification is enabled", () => {
      const target = resolveOperatorNotificationTarget(
        configWithNotificationEnabled(),
      );
      assert.ok(target);
      assert.equal(target.channel, "telegram");
      assert.equal(target.to, "operator-chat");
    });

    it("dry-run adapter does not send live messages", async () => {
      const config = configWithNotificationEnabled();
      // No runtime → adapter will be created but fail-closed on real sends
      const adapter = createA2AOperatorNotificationAdapter(config, undefined);
      // Adapter is created because config has a target,
      // but notify will not send live without a runtime
      assert.ok(adapter);
      const receipts = adapter!.listReceipts();
      assert.equal(receipts.length, 0);
    });

    it("buildA2AOpenClawTelegramOperatorNotification always sets dryRun when envelope has dryRun", () => {
      const event = buildOperatorReceiptEvent("current_session_visible");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);

      const withDryRun = buildA2AOperatorTerminalNotificationEnvelope(event, {
        dryRun: true,
      });
      assert.ok(withDryRun);
      assert.equal(withDryRun!.dryRun, true);

      const telegram = buildA2AOpenClawTelegramOperatorNotification(withDryRun!);
      assert.equal(telegram.dryRun, true);
      assert.equal(telegram.delivery.channel, "telegram");
    });
  });

  describe("ACK eligibility → gated on operator-visible receipt only", () => {
    it("envelope built from current_session_visible carries receiptProjection in evidence", () => {
      const event = buildOperatorReceiptEvent("current_session_visible");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
      assert.ok(envelope!.dedupeKey);
      assert.equal(envelope!.type, "success");
    });

    it("envelope built from manual_operator_receipt carries receiptProjection in evidence", () => {
      const event = buildOperatorReceiptEvent("manual_operator_receipt");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.evidence.receiptProjection, "manual_operator_receipt");
    });

    it("envelope severity is info for success (not error)", () => {
      const event = buildOperatorReceiptEvent("current_session_visible");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.severity, "info");
    });

    it("failure type produces error severity", () => {
      const event = buildTerminalEventPayload({
        type: "failed",
        receiptProjection: "current_session_visible",
        summary: "canary failure test",
      });
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.type, "failure");
      assert.equal(envelope!.severity, "error");
    });

    it("block type produces warn severity", () => {
      const event = buildTerminalEventPayload({
        type: "blocked",
        receiptProjection: "current_session_visible",
        summary: "canary block test",
      });
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.type, "block");
      assert.equal(envelope!.severity, "warn");
    });

    it("pr type produces info severity", () => {
      const event = buildTerminalEventPayload({
        type: "pr_opened",
        receiptProjection: "current_session_visible",
        summary: "canary pr test",
      });
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
      assert.ok(envelope);
      assert.equal(envelope!.type, "pr");
      assert.equal(envelope!.severity, "info");
    });
  });

  describe("canary round-trip: dry-run → Telegram projection → no live send", () => {
    it("multiple envelope types all stay in dry-run harness", () => {
      const harness = createA2ATelegramSafeDryRunNotificationHarness({
        maxNotifications: 20,
      });

      const types = [
        { type: "success", receiptProjection: "current_session_visible", summary: "완료" },
        { type: "failure", receiptProjection: "manual_operator_receipt", summary: "실패" },
        { type: "block", receiptProjection: "current_session_visible", summary: "차단" },
        { type: "pr", receiptProjection: "manual_operator_receipt", summary: "PR" },
      ] as const;

      for (const params of types) {
        const event = buildTerminalEventPayload({
          type: params.type,
          receiptProjection: params.receiptProjection,
          summary: params.summary,
        });
        const envelope = buildA2AOperatorTerminalNotificationEnvelope(event);
        assert.ok(envelope);
        harness.notify(envelope!);
      }

      const stats = harness.stats();
      assert.equal(stats.accepted, 4);

      const telegramList = harness.listTelegram();
      assert.equal(telegramList.length, 4);

      for (const notification of telegramList) {
        assert.equal(notification.dryRun, true);
        assert.equal(notification.delivery.mode, "announce");
        assert.equal(notification.delivery.channel, "telegram");
      }
    });

    it("outbox envelope built from current_session_visible carries receiptProjection in evidence", () => {
      const outbox = {
        id: "outbox-canary-visible",
        payload: {
          type: "success",
          taskId: "task-outbox-visible",
          worker: "workerBeta",
          repo: "jinwon-int/plugin-a2a",
          issue: 249,
          completedAt: "2026-05-10T03:00:00Z",
          receiptProjection: "current_session_visible",
          summary: "outbox with valid receipt projection",
        },
        createdAt: "2026-05-10T03:00:01Z",
      };
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
      assert.ok(envelope, "outbox with current_session_visible must produce envelope");
      assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
      assert.ok(
        envelope!.text.includes("Required receipt proof: current_session_visible"),
        "envelope text must label the requested proof without implying receipt evidence",
      );
    });

    it("outbox envelope built from manual_operator_receipt carries receiptProjection in evidence", () => {
      const outbox = {
        id: "outbox-canary-manual",
        payload: {
          type: "block",
          taskId: "task-outbox-manual",
          worker: "workerBeta",
          completedAt: "2026-05-10T03:00:00Z",
          receiptProjection: "manual_operator_receipt",
          summary: "outbox with manual receipt projection",
        },
        createdAt: "2026-05-10T03:00:01Z",
      };
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
      assert.ok(envelope, "outbox with manual_operator_receipt must produce envelope");
      assert.equal(envelope!.evidence.receiptProjection, "manual_operator_receipt");
      assert.ok(envelope!.text.includes("Required receipt proof: manual_operator_receipt"));
    });

    it("outbox builder infers current_session_visible for broker accepted/pending terminal rows", () => {
      const outbox = {
        id: "outbox-broker-accepted-pending",
        payload: {
          type: "success",
          taskId: "task-broker-accepted-pending",
          worker: "workerBeta",
          completedAt: "2026-05-10T03:00:00Z",
          summary: "broker terminal row awaiting operator-visible receipt",
        },
        createdAt: "2026-05-10T03:00:01Z",
        receipt: { status: "accepted", updatedAt: "2026-05-10T03:00:01Z" },
        ackAudit: {
          decision: "pending",
          reason: "terminal event accepted; awaiting current-session-visible/operator-visible/provider-delivery evidence before ACK",
          updatedAt: "2026-05-10T03:00:01Z",
          taskId: "task-broker-accepted-pending",
          receiptStatus: "accepted",
        },
      };
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
      assert.ok(envelope, "broker accepted/pending outbox row must produce envelope");
      assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
    });

    it("outbox builder infers current_session_visible for broker produced/pending terminal rows", () => {
      const outbox = {
        id: "outbox-broker-produced-pending",
        payload: {
          type: "failure",
          taskId: "task-broker-produced-pending",
          worker: "workerBeta",
          completedAt: "2026-05-10T03:00:00Z",
          summary: "broker terminal row produced but still awaiting operator-visible receipt",
        },
        createdAt: "2026-05-10T03:00:01Z",
        receipt: { status: "produced", updatedAt: "2026-05-10T03:00:02Z", note: "sidecar dry run produced a projection" },
        ackAudit: {
          decision: "pending",
          reason: "terminal ACK pending: notification has not produced current-session-visible/operator-visible/provider-delivery evidence",
          updatedAt: "2026-05-10T03:00:02Z",
          taskId: "task-broker-produced-pending",
          receiptStatus: "produced",
        },
      };
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
      assert.ok(envelope, "broker produced/pending outbox row must produce envelope");
      assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");
    });

    it("outbox builder rejects missing receipt projection (provider accepted only)", () => {
      const outbox = buildProviderAcceptedOnlyOutbox();
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
      assert.equal(envelope, undefined, "outbox without receipt projection or broker accepted/pending ackAudit must not produce envelope");
    });

    it("outbox builder rejects provider_send_success receipt projection", () => {
      const outbox = {
        id: "outbox-canary-provider-send",
        payload: {
          type: "success",
          taskId: "task-outbox-provider-send",
          worker: "workerBeta",
          receiptProjection: "provider_send_success",
          summary: "provider send success — non-ACK",
        },
        createdAt: "2026-05-10T03:00:01Z",
      };
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
      assert.equal(
        envelope,
        undefined,
        "outbox with provider_send_success must be rejected as non-ACK"
      );
    });

    it("outbox builder rejects all non-ACK receipt projections", () => {
      for (const projection of ["send_ok", "delivery_sent", "gateway_provider_send_success", "provider_accepted_send", "message_sent", "", "unknown_projection"]) {
        const outbox = {
          id: `outbox-canary-${projection}`,
          payload: {
            type: "success",
            taskId: `task-outbox-${projection}`,
            worker: "workerBeta",
            receiptProjection: projection || undefined,
            summary: `outbox with projection "${projection}"`,
          },
          createdAt: "2026-05-10T03:00:01Z",
        };
        const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(outbox);
        assert.equal(
          envelope,
          undefined,
          `outbox projection "${projection}" must not produce an envelope`,
        );
      }
    });

    it("no-live canary full boundary: disabled → accepted-only → receipt-gated → ACK eligible", () => {
      // 1. Notification disabled → no target
      assert.equal(
        resolveOperatorNotificationTarget(configWithNotificationDisabled()),
        undefined,
      );

      // 2. Provider accepted-only event → no envelope (fail-closed)
      const providerEvent = buildProviderAcceptedOnlyEvent();
      assert.equal(
        buildA2AOperatorTerminalNotificationEnvelope(providerEvent),
        undefined,
      );

      // 3. Receipt-gated event → envelope produced
      const receiptEvent = buildOperatorReceiptEvent("current_session_visible");
      const envelope = buildA2AOperatorTerminalNotificationEnvelope(receiptEvent);
      assert.ok(envelope);
      assert.equal(envelope!.evidence.receiptProjection, "current_session_visible");

      // 4. Dry-run harness records it without live send
      const harness = createA2ATelegramSafeDryRunNotificationHarness({
        maxNotifications: 5,
      });
      harness.notify(envelope!);
      assert.equal(harness.stats().accepted, 1);
      assert.equal(harness.stats().dropped, 0);

      // 5. Telegram projection exists but is dry-run only
      const telegramList = harness.listTelegram();
      assert.equal(telegramList.length, 1);
      assert.equal(telegramList[0].dryRun, true);
    });
  });

  describe("receipt gap projection — provider send ≠ operator ACK", () => {
    it("provider-accepted outbox → operatorReceipt = none", () => {
      const outbox = {
        id: "outbox-gap-001",
        payload: {
          type: "success",
          taskId: "task-gap-001",
          worker: "workerBeta",
          summary: "provider accepted, no receipt projection",
        },
        receipt: { status: "accepted" },
        createdAt: "2026-05-13T04:00:00Z",
      };
      const gap = getA2AOperatorTerminalOutboxReceiptGap(outbox);

      assert.equal(gap.providerDelivery, "accepted");
      assert.equal(gap.operatorReceipt, "none");
      assert.equal(gap.terminalAckEligible, false);
      assert.ok(
        gap.reason.includes("no operator-visible receipt evidence exists"),
        "reason must explicitly separate provider evidence from operator visibility proof",
      );
    });

    it("provider-sent outbox with no receipt projection → operatorReceipt = none", () => {
      const outbox = {
        id: "outbox-gap-002",
        payload: {
          type: "success",
          taskId: "task-gap-002",
          summary: "sent via provider gateway",
        },
        receipt: { status: "sent" },
        createdAt: "2026-05-13T04:00:00Z",
      };
      const gap = getA2AOperatorTerminalOutboxReceiptGap(outbox);

      assert.equal(gap.providerDelivery, "sent");
      // Provider sent ≠ operator visible
      assert.equal(gap.operatorReceipt, "none");
      assert.equal(gap.terminalAckEligible, false);
    });

    it("outbox with receiptProjection: current_session_visible → operator_visible", () => {
      const outbox = {
        id: "outbox-gap-003",
        payload: {
          type: "success",
          taskId: "task-gap-003",
          worker: "workerBeta",
          receiptProjection: "current_session_visible",
          summary: "operator-visible receipt",
        },
        receipt: { status: "accepted" },
        createdAt: "2026-05-13T04:00:00Z",
      };
      const gap = getA2AOperatorTerminalOutboxReceiptGap(outbox);

      assert.equal(gap.providerDelivery, "accepted");
      assert.equal(gap.operatorReceipt, "operator_visible");
      assert.equal(gap.terminalAckEligible, false);
      assert.equal(gap.operatorReceiptProjection, "current_session_visible");
    });

    it("outbox with manual_operator_receipt and confirmed ack → receipt_confirmed, ACK eligible", () => {
      const outbox = {
        id: "outbox-gap-004",
        payload: {
          type: "success",
          taskId: "task-gap-004",
          worker: "workerBeta",
          receiptProjection: "manual_operator_receipt",
          summary: "operator receipt confirmed",
        },
        receipt: { status: "accepted" },
        ack: { status: "receipt_confirmed", updatedAt: "2026-05-13T04:02:00Z" },
        createdAt: "2026-05-13T04:00:00Z",
      };
      const gap = getA2AOperatorTerminalOutboxReceiptGap(outbox);

      assert.equal(gap.providerDelivery, "accepted");
      assert.equal(gap.operatorReceipt, "receipt_confirmed");
      assert.equal(gap.terminalAckEligible, true);
      assert.equal(gap.operatorReceiptProjection, "manual_operator_receipt");
      assert.ok(gap.reason.includes("terminal ACK eligible"));
    });

    it("outbox with receiptProjection but pending ack → operator_visible (not confirmed)", () => {
      const outbox = {
        id: "outbox-gap-005",
        payload: {
          type: "success",
          taskId: "task-gap-005",
          worker: "workerBeta",
          receiptProjection: "current_session_visible",
          summary: "operator-visible but not yet ack-confirmed",
        },
        receipt: { status: "accepted" },
        ack: { status: "pending", updatedAt: "2026-05-13T04:01:00Z" },
        createdAt: "2026-05-13T04:00:00Z",
      };
      const gap = getA2AOperatorTerminalOutboxReceiptGap(outbox);

      assert.equal(gap.providerDelivery, "accepted");
      assert.equal(gap.operatorReceipt, "operator_visible");
      // ACK is pending → not yet eligible
      assert.equal(gap.terminalAckEligible, false);
    });

    it("provider delivery field is always separate from operator receipt field", () => {
      const outboxes = [
        { id: "1", payload: { type: "success", taskId: "t1" }, receipt: { status: "accepted" }, createdAt: "2026-05-13T04:00:00Z" },
        { id: "2", payload: { type: "success", taskId: "t2" }, receipt: { status: "sent" }, createdAt: "2026-05-13T04:00:00Z" },
        { id: "3", payload: { type: "success", taskId: "t3", receiptProjection: "current_session_visible" }, receipt: { status: "delivered" }, createdAt: "2026-05-13T04:00:00Z" },
        { id: "4", payload: { type: "success", taskId: "t4", receiptProjection: "manual_operator_receipt" }, receipt: { status: "accepted" }, ack: { status: "receipt_confirmed" }, createdAt: "2026-05-13T04:00:00Z" },
      ];

      for (const outbox of outboxes) {
        const gap = getA2AOperatorTerminalOutboxReceiptGap(outbox);

        // providerDelivery and operatorReceipt are distinct fields, always present
        assert.ok(typeof gap.providerDelivery === "string", "providerDelivery must always be a string");
        assert.ok(typeof gap.operatorReceipt === "string", "operatorReceipt must always be a string");
        assert.ok(gap.reason.length > 0, "reason must be non-empty");

        // Provider delivery being "sent" or "delivered" does not make ACK eligible
        if (gap.operatorReceiptProjection === undefined) {
          assert.equal(gap.terminalAckEligible, false);
        }
      }
    });
  });
});

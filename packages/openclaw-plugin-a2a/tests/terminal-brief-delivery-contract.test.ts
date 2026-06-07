import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeTerminalBriefConfirmationSource,
  normalizeTerminalBriefDeliveryReceiptDecision,
  normalizeTerminalBriefReceiptStatus,
} from "../dist/src/terminal-brief-delivery-contract.js";

describe("Terminal Brief delivery adapter contract", () => {
  it("accepts current-session-visible receipt decisions", () => {
    const decision = normalizeTerminalBriefDeliveryReceiptDecision({
      ackTerminalEvent: true,
      confirmation_source: "operator-visible",
      receipt_id: "harness:message:1",
      reason: "operator-visible receipt confirmed",
    });

    assert.deepEqual(decision, {
      ackTerminalEvent: true,
      confirmationSource: "current_session_visible",
      receiptId: "harness:message:1",
      reason: "operator-visible receipt confirmed",
    });
  });

  it("accepts manual operator receipt decisions", () => {
    const decision = normalizeTerminalBriefDeliveryReceiptDecision({
      ackTerminalEvent: true,
      confirmationSource: "manual_operator_receipt",
      receiptId: "manual:receipt:1",
    });

    assert.deepEqual(decision, {
      ackTerminalEvent: true,
      confirmationSource: "manual_operator_receipt",
      receiptId: "manual:receipt:1",
    });
  });

  it("fails closed for provider-only receipt decisions even when ACK is requested", () => {
    const decision = normalizeTerminalBriefDeliveryReceiptDecision({
      ackTerminalEvent: true,
      confirmationSource: "provider_accepted",
      receiptId: "telegram:message:transport-only",
      reason: "provider accepted",
    });

    assert.deepEqual(decision, {
      ackTerminalEvent: false,
      receiptId: "telegram:message:transport-only",
      reason: "provider accepted",
    });
  });

  it("fails closed for provider_sent confirmation source even when ACK is requested", () => {
    const decision = normalizeTerminalBriefDeliveryReceiptDecision({
      ackTerminalEvent: true,
      confirmationSource: "provider_sent",
      receiptId: "telegram:message:transport-sent",
      reason: "provider send acknowledged transport only",
    });

    assert.deepEqual(decision, {
      ackTerminalEvent: false,
      receiptId: "telegram:message:transport-sent",
      reason: "provider send acknowledged transport only",
    });
  });

  it("normalizes public receipt source aliases", () => {
    assert.equal(normalizeTerminalBriefConfirmationSource("user-visible"), "current_session_visible");
    assert.equal(normalizeTerminalBriefConfirmationSource("operator_confirmed"), "manual_operator_receipt");
    assert.equal(normalizeTerminalBriefConfirmationSource("provider-delivered"), undefined);

    // Additional alias paths
    assert.equal(normalizeTerminalBriefConfirmationSource("operator-visible"), "current_session_visible");
    assert.equal(normalizeTerminalBriefConfirmationSource("operator_visible"), "current_session_visible");
    assert.equal(normalizeTerminalBriefConfirmationSource("user_visible"), "current_session_visible");
    assert.equal(normalizeTerminalBriefConfirmationSource("operator_visible_manual"), "manual_operator_receipt");
  });

  it("accepts non-ACK receipt status for harness-neutral spool adapters", () => {
    const decision = normalizeTerminalBriefDeliveryReceiptDecision({
      ackTerminalEvent: false,
      terminal_receipt_status: "produced",
      receipt_id: "hermes-gongyung:gongyung:1",
      reason: "spooled for Gongyung worker",
    });

    assert.deepEqual(decision, {
      ackTerminalEvent: false,
      terminalReceiptStatus: "produced",
      receiptId: "hermes-gongyung:gongyung:1",
      reason: "spooled for Gongyung worker",
    });
  });

  it("normalizes public receipt status aliases", () => {
    assert.equal(normalizeTerminalBriefReceiptStatus("provider-delivered-if-known"), "provider_sent");
    assert.equal(normalizeTerminalBriefReceiptStatus("provider accepted"), "provider_accepted");
    assert.equal(normalizeTerminalBriefReceiptStatus("operator_visible"), undefined);
  });
});

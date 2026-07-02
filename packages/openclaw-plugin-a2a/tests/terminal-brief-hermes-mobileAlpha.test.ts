import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function envelope() {
  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: "terminal-brief-hermes-mobileAlpha-test",
    dedupeKey: "terminal-brief-hermes-mobileAlpha-test",
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A Terminal Brief 완료: mobileAlpha(1/1)",
    text: "A2A Terminal Brief 완료: mobileAlpha(1/1)\nsummary",
    evidence: {
      schema: "a2a.operator.notification.evidence",
      version: 1,
      taskId: "terminal-brief-hermes-mobileAlpha-test",
      worker: "mobileAlpha",
      status: "succeeded",
    },
    taskId: "terminal-brief-hermes-mobileAlpha-test",
    worker: "mobileAlpha",
    status: "succeeded",
  };
}

function minimalEnvelope() {
  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: "terminal-brief-hermes-mobileAlpha-minimal-test",
    dedupeKey: "terminal-brief-hermes-mobileAlpha-minimal-test",
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A Terminal Brief 완료: mobileAlpha(1/1)",
    text: "Minimal dry-run spool smoke only.",
    taskId: "terminal-brief-hermes-mobileAlpha-minimal-test",
    workerId: "mobileAlpha",
    status: "succeeded",
  };
}

function runAdapter(args: string[] = [], input = envelope()) {
  const child = spawnSync(process.execPath, [
    "dist/terminal-brief-hermes-mobileAlpha.js",
    ...args,
  ], {
    cwd: process.cwd(),
    input: JSON.stringify(input),
    encoding: "utf8",
  });

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    decision: JSON.parse(child.stdout),
  };
}

function writeReceiptEvidence(tempDir: string, records: unknown[]): string {
  const evidenceFile = join(tempDir, "receipt-evidence.jsonl");
  writeFileSync(evidenceFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return evidenceFile;
}

function recentIso(): string {
  return new Date().toISOString();
}

function staleIso(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

describe("Terminal Brief Hermes/mobileAlpha adapter skeleton", () => {
  it("defaults to dry-run/spool-only receipt without terminal ACK", () => {
    const result = runAdapter();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.decision.ackTerminalEvent, false);
    assert.equal(result.decision.terminalReceiptStatus, "produced");
    assert.match(result.decision.reason, /dry-run\/spool only/);
    assert.equal(result.decision.receiptId, "hermes-mobileAlpha:mobileAlpha:terminal-brief-hermes-mobileAlpha-test");
  });

  it("spools a public-safe record without treating spool as receipt", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-"));
    const spoolFile = join(tempDir, "spool.jsonl");
    try {
      const result = runAdapter(["--spool-file", spoolFile, "--operator", "mobileAlpha"]);
      const record = JSON.parse(readFileSync(spoolFile, "utf8").trim());

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.decision.ackTerminalEvent, false);
      assert.equal(result.decision.terminalReceiptStatus, "produced");
      assert.equal(record.schema, "a2a.terminalBrief.hermesmobileAlphaAdapter.spool.v1");
      assert.equal(record.operator, "mobileAlpha");
      assert.equal(record.taskId, "terminal-brief-hermes-mobileAlpha-test");
      assert.equal(record.safety.providerSend, false);
      assert.equal(record.safety.terminalAck, false);
      assert.equal(record.safety.dryRunOnly, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("spools a minimal workerId envelope without evidence", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-minimal-"));
    const spoolFile = join(tempDir, "spool.jsonl");
    try {
      const result = runAdapter(["--spool-file", spoolFile, "--operator", "mobileAlpha"], minimalEnvelope());
      const record = JSON.parse(readFileSync(spoolFile, "utf8").trim());

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.decision.ackTerminalEvent, false);
      assert.equal(record.taskId, "terminal-brief-hermes-mobileAlpha-minimal-test");
      assert.equal(record.worker, "mobileAlpha");
      assert.equal(record.status, "succeeded");
      assert.equal(record.safety.providerSend, false);
      assert.equal(record.safety.terminalAck, false);
      assert.equal(record.safety.dryRunOnly, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows explicit manual operator receipt projection", () => {
    const result = runAdapter(["--manual-receipt-id", "manual:mobileAlpha:1"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.decision, {
      ackTerminalEvent: true,
      confirmationSource: "manual_operator_receipt",
      receiptId: "manual:mobileAlpha:1",
      reason: "Hermes/mobileAlpha adapter received manual operator receipt",
    });
  });

  it("allows explicit current-session visible receipt projection", () => {
    const result = runAdapter(["--visible-receipt-id", "hermes:mobileAlpha:visible:1"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.decision, {
      ackTerminalEvent: true,
      confirmationSource: "current_session_visible",
      receiptId: "hermes:mobileAlpha:visible:1",
      reason: "Hermes/mobileAlpha adapter received current-session-visible confirmation",
    });
  });

  it("ACKs current-session-visible receipt evidence matched by envelope id", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-receipt-"));
    try {
      const evidenceFile = writeReceiptEvidence(tempDir, [{
        schema: "a2a.terminalBrief.hermesmobileAlpha.receipt.v1",
        operator: "mobileAlpha",
        envelopeId: "terminal-brief-hermes-mobileAlpha-test",
        confirmationSource: "current_session_visible",
        status: "visible",
        receiptId: "hermes:mobileAlpha:visible:1",
        observedAt: recentIso(),
      }]);

      const result = runAdapter(["--receipt-evidence-file", evidenceFile]);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.decision, {
        ackTerminalEvent: true,
        confirmationSource: "current_session_visible",
        receiptId: "hermes:mobileAlpha:visible:1",
        reason: "Hermes/mobileAlpha receipt evidence confirmed current_session_visible",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ACKs manual operator receipt evidence matched by task id", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-manual-"));
    try {
      const evidenceFile = writeReceiptEvidence(tempDir, [{
        schema: "a2a.terminalBrief.hermesmobileAlpha.receipt.v1",
        operator: "mobileAlpha",
        taskId: "terminal-brief-hermes-mobileAlpha-test",
        receiptMode: "manual_operator_receipt",
        status: "operator_confirmed",
        receiptId: "manual:mobileAlpha:1",
        observedAt: recentIso(),
      }]);

      const result = runAdapter(["--receipt-evidence-file", evidenceFile]);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.decision, {
        ackTerminalEvent: true,
        confirmationSource: "manual_operator_receipt",
        receiptId: "manual:mobileAlpha:1",
        reason: "Hermes/mobileAlpha receipt evidence confirmed manual_operator_receipt",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not ACK provider-only receipt evidence", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-provider-"));
    try {
      const evidenceFile = writeReceiptEvidence(tempDir, [{
        schema: "a2a.terminalBrief.hermesmobileAlpha.receipt.v1",
        operator: "mobileAlpha",
        dedupeKey: "terminal-brief-hermes-mobileAlpha-test",
        source: "provider_sent",
        status: "provider_sent",
        receiptId: "provider:mobileAlpha:1",
        observedAt: recentIso(),
      }]);

      const result = runAdapter(["--receipt-evidence-file", evidenceFile]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.decision.ackTerminalEvent, false);
      assert.equal(result.decision.terminalReceiptStatus, "failed");
      assert.match(result.decision.reason, /missing current-session-visible or manual receipt source/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks matching stale receipt evidence as stale without ACK", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-stale-"));
    try {
      const evidenceFile = writeReceiptEvidence(tempDir, [{
        schema: "a2a.terminalBrief.hermesmobileAlpha.receipt.v1",
        operator: "mobileAlpha",
        envelopeId: "terminal-brief-hermes-mobileAlpha-test",
        confirmationSource: "current_session_visible",
        status: "visible",
        receiptId: "hermes:mobileAlpha:visible:old",
        observedAt: staleIso(),
      }]);

      const result = runAdapter(["--receipt-evidence-file", evidenceFile, "--receipt-max-age-ms", "1000"]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.decision.ackTerminalEvent, false);
      assert.equal(result.decision.terminalReceiptStatus, "stale");
      assert.match(result.decision.reason, /receipt evidence is stale/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects receipt evidence for a different operator or envelope", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-hermes-mobileAlpha-mismatch-"));
    try {
      const evidenceFile = writeReceiptEvidence(tempDir, [{
        schema: "a2a.terminalBrief.hermesmobileAlpha.receipt.v1",
        operator: "other",
        envelopeId: "terminal-brief-hermes-mobileAlpha-test",
        confirmationSource: "current_session_visible",
        status: "visible",
        receiptId: "hermes:other:visible:1",
        observedAt: recentIso(),
      }, {
        schema: "a2a.terminalBrief.hermesmobileAlpha.receipt.v1",
        operator: "mobileAlpha",
        envelopeId: "other-envelope",
        confirmationSource: "current_session_visible",
        status: "visible",
        receiptId: "hermes:mobileAlpha:visible:other",
        observedAt: recentIso(),
      }]);

      const result = runAdapter(["--receipt-evidence-file", evidenceFile]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.decision.ackTerminalEvent, false);
      assert.equal(result.decision.terminalReceiptStatus, "failed");
      assert.match(result.decision.reason, /record does not match envelope id, dedupeKey, or taskId/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

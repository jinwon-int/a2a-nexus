import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function envelope() {
  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: "terminal-brief-openclaw-message-test",
    dedupeKey: "terminal-brief-openclaw-message-test",
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A Terminal Brief 완료: workerBeta(1/1)",
    text: "A2A Terminal Brief 완료: workerBeta(1/1)\nsummary",
    evidence: {
      schema: "a2a.operator.notification.evidence",
      version: 1,
      taskId: "terminal-brief-openclaw-message-test",
      worker: "workerBeta",
      receiptProjection: "current_session_visible",
    },
    taskId: "terminal-brief-openclaw-message-test",
    worker: "workerBeta",
    status: "succeeded",
  };
}

function runNotifier(openclawResult: unknown, args: string[] = []) {
  const tempDir = mkdtempSync(join(tmpdir(), "terminal-brief-openclaw-message-"));
  try {
    const argsFile = join(tempDir, "args.json");
    const openclawBin = join(tempDir, "openclaw-fixture.mjs");
    writeFileSync(openclawBin, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(openclawResult))});`,
    ].join("\n"));
    chmodSync(openclawBin, 0o755);

    const child = spawnSync(process.execPath, [
      "dist/terminal-brief-openclaw-message.js",
      "--openclaw-bin",
      openclawBin,
      "--channel",
      "telegram",
      "--target",
      "telegram:1000000001",
      ...args,
    ], {
      cwd: process.cwd(),
      input: JSON.stringify(envelope()),
      encoding: "utf8",
    });

    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      decision: JSON.parse(child.stdout),
      openclawArgs: JSON.parse(readFileSync(argsFile, "utf8")),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Terminal Brief OpenClaw message notifier", () => {
  it("ACKs only when OpenClaw result contains current-session visibility receipt", () => {
    const result = runNotifier({
      action: "send",
      channel: "telegram",
      handledBy: "core",
      payload: { to: "telegram:1000000001" },
      result: {
        messageId: "telegram-message-1",
        confirmation: { source: "current_session_visible" },
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.decision.ackTerminalEvent, true);
    assert.equal(result.decision.confirmationSource, "current_session_visible");
    assert.equal(result.decision.receiptId, "telegram-message-1");
    assert.deepEqual(result.openclawArgs.slice(0, 6), [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "telegram:1000000001",
    ]);
    assert.ok(result.openclawArgs.includes("A2A Terminal Brief 완료: workerBeta(1/1)\nsummary"));
  });

  it("does not ACK provider-only message send results", () => {
    const result = runNotifier({
      action: "send",
      channel: "telegram",
      handledBy: "core",
      payload: { to: "telegram:1000000001" },
      result: { messageId: "telegram-message-2", status: "sent" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.decision.ackTerminalEvent, false);
    assert.match(result.decision.reason, /provider acceptance is not terminal ACK evidence/);
    assert.equal(result.decision.receiptId, "telegram-message-2");
  });

  it("keeps OpenClaw dry-run sends unacknowledged", () => {
    const result = runNotifier({
      action: "send",
      channel: "telegram",
      dryRun: true,
      handledBy: "dry-run",
      payload: { dryRun: true },
    }, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.decision.ackTerminalEvent, false);
    assert.match(result.decision.reason, /dry-run/);
    assert.ok(result.openclawArgs.includes("--dry-run"));
  });
});

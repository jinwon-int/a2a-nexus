import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLiveOperationTask } from "./lib/live-operation-adapter.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "a2a-live-adapter-"));
  const manifestPath = join(dir, "runbooks.json");
  const commandPath = join(dir, "a2a-ccc-node-rollout");
  writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
  chmodSync(commandPath, 0o700);
  writeFileSync(manifestPath, JSON.stringify({
    schema: "a2a.live-runbooks.v1",
    runbooks: {
      "ccc-node-3node-rollout-v1": {
        command: commandPath,
        targetPrefix: "ccc-node:",
        timeoutSec: 900,
      },
    },
  }));
  chmodSync(manifestPath, 0o600);
  return { dir, manifestPath, commandPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function task(overrides = {}) {
  return {
    id: "task-live-343-1",
    intent: "promote_to_live",
    targetNodeId: "nosuk",
    assignedWorkerId: "nosuk",
    payload: {
      mode: "promote-to-live-v1",
      liveOperation: {
        schema: "a2a.live-operation.v1",
        runId: "run-343-1",
        action: "promote_to_live_apply",
        target: "ccc-node:fleet:dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
        targetWorkerId: "nosuk",
        targetSha: "dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
        runbookId: "ccc-node-3node-rollout-v1",
        approvalTokenIssuedAt: "2026-07-10T20:29:30.000Z",
      },
      approvalReceipt: {
        schema: "a2a.live-approval-receipt.v1",
        brokerId: "seoseo",
        taskId: "task-live-343-1",
        runId: "run-343-1",
        action: "promote_to_live_apply",
        target: "ccc-node:fleet:dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
        targetWorkerId: "nosuk",
        targetSha: "dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
        runbookId: "ccc-node-3node-rollout-v1",
        consumedAt: "2026-07-10T20:30:00.000Z",
        consumptionKey: "live-approval-key-1",
        receiptMac: "a".repeat(64),
      },
    },
    ...overrides,
  };
}

function env(manifestPath, capabilityOverrides = {}) {
  return {
    A2A_NODE_ID: "nosuk",
    A2A_BROKER_URL: "http://127.0.0.1:8787",
    BROKER_EDGE_SECRET: "test-worker-edge-secret-32-bytes",
    A2A_LIVE_RUNBOOKS_FILE: manifestPath,
    WORKER_CAPABILITIES_JSON: JSON.stringify({
      canPromoteLive: true,
      environments: ["research", "staging", "live"],
      ...capabilityOverrides,
    }),
  };
}

function successfulSpawn(calls, canonicalTask = task()) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/curl") {
      assert.ok(!args.some((value) => String(value).includes("test-worker-edge-secret")));
      assert.match(String(options.input), /x-a2a-edge-secret/);
      return { status: 0, signal: null, stdout: JSON.stringify(canonicalTask), stderr: "" };
    }
    const values = Object.fromEntries(args.reduce((pairs, value, index) => {
      if (String(value).startsWith("--")) pairs.push([String(value).slice(2), args[index + 1]]);
      return pairs;
    }, []));
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        schema: "a2a.live-runbook-phase-result.v1",
        ok: true,
        phase: values.phase,
        taskId: values["task-id"],
        runId: values["run-id"],
        target: values.target,
        sentinel: `${values.phase}:${values["task-id"]}:${values["run-id"]}`,
        verification: values.phase === "verify" ? { done: true, targetSha: values["target-sha"] } : undefined,
      }),
      stderr: "",
    };
  };
}

test("deterministic live adapter executes only allowlisted preflight/apply/verify phases without a shell", () => {
  const fx = fixture();
  try {
    const calls = [];
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), { spawnSync: successfulSpawn(calls) });
    assert.equal(outcome.error, undefined);
    assert.deepEqual(calls.map((call) => call.command), [
      "/usr/bin/curl",
      fx.commandPath,
      fx.commandPath,
      fx.commandPath,
    ]);
    assert.deepEqual(calls.filter((call) => call.command === fx.commandPath).map((call) => call.args[1]), ["preflight", "apply", "verify"]);
    assert.deepEqual(calls.filter((call) => call.command === fx.commandPath).map((call) => call.options.env.A2A_NODE_ID), ["nosuk", "nosuk", "nosuk"]);
    assert.ok(calls.every((call) => call.options.shell === false));
    assert.equal(outcome.result.verification.done, true);
    assert.equal(outcome.result.evidence.length, 3);
  } finally {
    fx.cleanup();
  }
});

test("deterministic live adapter fails closed before execution without live capability", () => {
  const fx = fixture();
  try {
    const calls = [];
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath, { canPromoteLive: false }), { spawnSync: successfulSpawn(calls) });
    assert.equal(outcome.error.code, "live_capability_required");
    assert.equal(calls.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("deterministic live adapter rejects prompt-derived command fields and unknown runbooks", () => {
  const fx = fixture();
  try {
    const calls = [];
    const base = task();
    base.payload.liveOperation.command = "sh -c 'touch /tmp/pwned'";
    let outcome = runLiveOperationTask(base, env(fx.manifestPath), { spawnSync: successfulSpawn(calls) });
    assert.equal(outcome.error.code, "invalid_live_operation");
    assert.equal(calls.length, 0);

    const unknown = task();
    unknown.payload.liveOperation.runbookId = "operator-supplied";
    unknown.payload.approvalReceipt.runbookId = "operator-supplied";
    outcome = runLiveOperationTask(unknown, env(fx.manifestPath), { spawnSync: successfulSpawn(calls, unknown) });
    assert.equal(outcome.error.code, "runbook_not_allowed");
    assert.equal(calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("deterministic live adapter requires the local task to match the trusted broker record", () => {
  const fx = fixture();
  try {
    const calls = [];
    const canonical = task();
    canonical.payload.approvalReceipt.receiptMac = "b".repeat(64);
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), { spawnSync: successfulSpawn(calls, canonical) });
    assert.equal(outcome.error.code, "trusted_broker_confirmation_mismatch");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/bin/curl");
  } finally {
    fx.cleanup();
  }
});

test("deterministic live adapter executes rollback and verify only for separately approved rollback tasks", () => {
  const fx = fixture();
  try {
    const calls = [];
    const rollback = task({ intent: "rollback_live" });
    rollback.payload.liveOperation.action = "promote_to_live_rollback";
    rollback.payload.approvalReceipt.action = "promote_to_live_rollback";
    const outcome = runLiveOperationTask(rollback, env(fx.manifestPath), { spawnSync: successfulSpawn(calls, rollback) });
    assert.equal(outcome.error, undefined);
    assert.deepEqual(calls.filter((call) => call.command === fx.commandPath).map((call) => call.args[1]), ["rollback", "verify"]);
    assert.equal(outcome.result.action, "promote_to_live_rollback");
  } finally {
    fx.cleanup();
  }
});

test("deterministic live adapter rejects wrapper-only success without verify sentinel", () => {
  const fx = fixture();
  try {
    const calls = [];
    const spawn = successfulSpawn(calls);
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), {
      spawnSync(command, args, options) {
        const result = spawn(command, args, options);
        if (args[1] === "verify") result.stdout = JSON.stringify({ ok: true, phase: "verify" });
        return result;
      },
    });
    assert.equal(outcome.error.code, "live_verification_failed");
    assert.equal(calls.length, 4);
  } finally {
    fx.cleanup();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLiveOperationTask } from "./lib/live-operation-adapter.mjs";

// #2535: the runbook fixtures live in a temp dir owned by whoever runs the
// test. The adapter takes the expected owner uid of the runbook manifest and
// command from code-only `dependencies.trustedOwnerUid` (default 0 = root), so
// these tests pass the test process uid and run on non-root CI runners. Every
// other check (regular non-symlink file, realpath, no group/other write,
// executable command) stays real; /usr/bin/curl is always checked against uid 0.
const OWNER_UID = process.getuid();
const IS_ROOT = OWNER_UID === 0;

function deps(spawnSync) {
  return { spawnSync, trustedOwnerUid: OWNER_UID };
}

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
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), deps(successfulSpawn(calls)));
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
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath, { canPromoteLive: false }), deps(successfulSpawn(calls)));
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
    let outcome = runLiveOperationTask(base, env(fx.manifestPath), deps(successfulSpawn(calls)));
    assert.equal(outcome.error.code, "invalid_live_operation");
    assert.equal(calls.length, 0);

    const unknown = task();
    unknown.payload.liveOperation.runbookId = "operator-supplied";
    unknown.payload.approvalReceipt.runbookId = "operator-supplied";
    outcome = runLiveOperationTask(unknown, env(fx.manifestPath), deps(successfulSpawn(calls, unknown)));
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
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), deps(successfulSpawn(calls, canonical)));
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
    const outcome = runLiveOperationTask(rollback, env(fx.manifestPath), deps(successfulSpawn(calls, rollback)));
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
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), deps((command, args, options) => {
      const result = spawn(command, args, options);
      if (args[1] === "verify") result.stdout = JSON.stringify({ ok: true, phase: "verify" });
      return result;
    }));
    assert.equal(outcome.error.code, "live_verification_failed");
    assert.equal(calls.length, 4);
  } finally {
    fx.cleanup();
  }
});

// #2533: the failed-phase stderr is cut to 2000 UTF-16 units; the cut must not
// split a surrogate pair.
test("failed runbook phase stderr excerpt never splits a surrogate pair", () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const fx = fixture();
  try {
    const calls = [];
    const succeed = successfulSpawn(calls);
    const spawn = (command, args, options) => {
      if (command === "/usr/bin/curl") return succeed(command, args, options);
      calls.push({ command, args, options });
      // index 1999 is the high half of the emoji
      return { status: 1, signal: null, stdout: "", stderr: `${"r".repeat(1999)}😀tail` };
    };
    const outcome = runLiveOperationTask(task(), env(fx.manifestPath), deps(spawn));
    assert.equal(outcome.error?.code, "live_runbook_phase_failed");
    const stderr = outcome.error.details.stderr;
    assert.ok(stderr.length <= 2000);
    assert.equal(stderr, "r".repeat(1999), "backs off exactly the split pair");
    assert.equal(LONE_SURROGATE.test(stderr), false);
  } finally {
    fx.cleanup();
  }
});

// #2535: the owner-uid seam is code-only and validated; it never relaxes the
// file-type, symlink, realpath, mode or executable checks.
test("trustedOwnerUid must be a non-negative safe integer; anything else fails closed before any spawn (#2535)", () => {
  const fx = fixture();
  try {
    for (const trustedOwnerUid of [-1, "0", String(OWNER_UID), 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, true, {}, [0]]) {
      const calls = [];
      const outcome = runLiveOperationTask(task(), env(fx.manifestPath), { spawnSync: successfulSpawn(calls), trustedOwnerUid });
      assert.equal(outcome.error?.code, "invalid_live_operation", `trustedOwnerUid ${String(trustedOwnerUid)} is rejected`);
      assert.match(outcome.error.message, /trustedOwnerUid/);
      assert.equal(calls.length, 0, `nothing runs for trustedOwnerUid ${String(trustedOwnerUid)}`);
    }
  } finally {
    fx.cleanup();
  }
});

test("a trustedOwnerUid that is not the fixture owner rejects the runbook manifest; env and task cannot override it (#2535)", () => {
  const fx = fixture();
  try {
    const calls = [];
    const carrier = task({ trustedOwnerUid: OWNER_UID });
    carrier.payload.trustedOwnerUid = OWNER_UID;
    const carrierEnv = { ...env(fx.manifestPath), trustedOwnerUid: String(OWNER_UID), A2A_TRUSTED_OWNER_UID: String(OWNER_UID), A2A_LIVE_TRUSTED_OWNER_UID: String(OWNER_UID) };
    const outcome = runLiveOperationTask(carrier, carrierEnv, { spawnSync: successfulSpawn(calls, carrier), trustedOwnerUid: OWNER_UID + 1 });
    assert.equal(outcome.error?.code, "invalid_live_operation", JSON.stringify(outcome));
    assert.match(outcome.error.message, /^live runbook manifest must be owned by the trusted owner uid and not group\/other writable$/);
    assert.deepEqual(calls.map((call) => call.command), ["/usr/bin/curl"], "no runbook phase runs");
  } finally {
    fx.cleanup();
  }
});

test("without the dependency the default owner uid 0 is enforced even when env and task carry an owner uid (#2535)", {
  skip: IS_ROOT ? "running as root: the temp fixture is owned by uid 0, so the default cannot be told apart here (the non-root CI run covers it)" : false,
}, () => {
  const fx = fixture();
  try {
    const calls = [];
    const carrier = task({ trustedOwnerUid: OWNER_UID });
    carrier.payload.trustedOwnerUid = OWNER_UID;
    const carrierEnv = { ...env(fx.manifestPath), trustedOwnerUid: String(OWNER_UID), A2A_TRUSTED_OWNER_UID: String(OWNER_UID) };
    for (const dependencies of [{ spawnSync: successfulSpawn(calls, carrier) }, { spawnSync: successfulSpawn(calls, carrier), trustedOwnerUid: undefined }]) {
      const outcome = runLiveOperationTask(carrier, carrierEnv, dependencies);
      assert.equal(outcome.error?.code, "invalid_live_operation", JSON.stringify(outcome));
      assert.match(outcome.error.message, /^live runbook manifest must be root-owned and not group\/other writable$/);
    }
    assert.ok(calls.every((call) => call.command === "/usr/bin/curl"), "no runbook phase runs");
  } finally {
    fx.cleanup();
  }
});

test("with the owner-uid seam a group/other-writable manifest or command is still rejected (#2535)", () => {
  for (const [target, mode, label] of [
    ["manifestPath", 0o620, "live runbook manifest"],
    ["manifestPath", 0o602, "live runbook manifest"],
    ["commandPath", 0o770, "runbook ccc-node-3node-rollout-v1 command"],
    ["commandPath", 0o707, "runbook ccc-node-3node-rollout-v1 command"],
  ]) {
    const fx = fixture();
    try {
      chmodSync(fx[target], mode);
      const calls = [];
      const outcome = runLiveOperationTask(task(), env(fx.manifestPath), deps(successfulSpawn(calls)));
      assert.equal(outcome.error?.code, "invalid_live_operation", `${target} ${mode.toString(8)}`);
      assert.match(outcome.error.message, new RegExp(`^${label} must be (?:root-owned|owned by the trusted owner uid) and not group/other writable$`));
      assert.deepEqual(calls.map((call) => call.command), ["/usr/bin/curl"]);
    } finally {
      fx.cleanup();
    }
  }
});

test("with the owner-uid seam a symlinked manifest or command and a non-executable command are still rejected (#2535)", () => {
  const cases = [
    ["symlinked manifest", (fx) => {
      const link = join(fx.dir, "runbooks-link.json");
      symlinkSync(fx.manifestPath, link);
      return link;
    }, /^live runbook manifest must be a regular non-symlink file$/],
    ["symlinked command", (fx) => {
      const link = join(fx.dir, "rollout-link");
      symlinkSync(fx.commandPath, link);
      writeFileSync(fx.manifestPath, JSON.stringify({
        schema: "a2a.live-runbooks.v1",
        runbooks: { "ccc-node-3node-rollout-v1": { command: link, targetPrefix: "ccc-node:", timeoutSec: 900 } },
      }));
      return fx.manifestPath;
    }, /^runbook ccc-node-3node-rollout-v1 command must be a regular non-symlink file$/],
    ["non-executable command", (fx) => {
      chmodSync(fx.commandPath, 0o600);
      return fx.manifestPath;
    }, /^runbook ccc-node-3node-rollout-v1 command must be executable$/],
  ];
  for (const [name, prepare, expected] of cases) {
    const fx = fixture();
    try {
      const manifestPath = prepare(fx);
      const calls = [];
      const outcome = runLiveOperationTask(task(), env(manifestPath), deps(successfulSpawn(calls)));
      assert.equal(outcome.error?.code, "invalid_live_operation", name);
      assert.match(outcome.error.message, expected, name);
      assert.deepEqual(calls.map((call) => call.command), ["/usr/bin/curl"], `${name}: no runbook phase runs`);
    } finally {
      fx.cleanup();
    }
  }
});

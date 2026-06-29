import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTerminalActionGate,
  evaluateDeclaredWriteSetGate,
  type TerminalActionRequest,
  buildStableRuntimeIdempotencyKey,
  evaluateRuntimeReplayGate,
  evaluateWorkerRuntimeBoundary,
  buildRuntimeAuditEvent,
} from "./runtime-safety-gates.js";

const NOW = "2026-06-29T14:20:00.000Z";

function request(overrides: Partial<TerminalActionRequest> = {}): TerminalActionRequest {
  return {
    action: "git_push",
    actorRole: "implementer",
    actorId: "worker-a",
    finalizerOnly: true,
    freshApprovalToken: null,
    approvalTokenIssuedAt: null,
    now: NOW,
    ...overrides,
  };
}

test("terminal action gate denies side-effecting actions from non-finalizers without a fresh approval token", () => {
  const decision = evaluateTerminalActionGate(request());

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "non_finalizer_actor");
  assert.deepEqual(decision.blockers, [
    "terminal action git_push requires finalizer actor",
    "terminal action git_push requires a fresh approval token",
  ]);
});

test("terminal action gate allows finalizer with scoped fresh approval token", () => {
  const decision = evaluateTerminalActionGate(request({
    actorRole: "finalizer",
    actorId: "seoseo-finalizer",
    freshApprovalToken: "approval:git_push:20260629T1419Z",
    approvalTokenIssuedAt: "2026-06-29T14:19:30.000Z",
    approvalTokenMaxAgeMs: 120_000,
  }));

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "allowed_finalizer_fresh_approval");
  assert.deepEqual(decision.blockers, []);
});

test("terminal action gate denies stale finalizer approval tokens", () => {
  const decision = evaluateTerminalActionGate(request({
    actorRole: "finalizer",
    freshApprovalToken: "approval:deploy:old",
    approvalTokenIssuedAt: "2026-06-29T14:00:00.000Z",
    approvalTokenMaxAgeMs: 120_000,
    action: "deploy_restart",
  }));

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "stale_approval_token");
  assert.match(decision.blockers.join("\n"), /fresh approval token/);
});

test("declared write-set gate allows exact and glob-scoped files", () => {
  const decision = evaluateDeclaredWriteSetGate({
    declaredWriteSet: ["packages/broker/src/core/**", "packages/broker/scripts/*.mjs"],
    touchedFiles: [
      "packages/broker/src/core/runtime-safety-gates.ts",
      "packages/broker/scripts/claude-a2a-patch-bridge.mjs",
    ],
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.outOfScopeFiles, []);
  assert.equal(decision.quarantineRequired, false);
});

test("declared write-set gate quarantines out-of-scope files before finalize", () => {
  const decision = evaluateDeclaredWriteSetGate({
    declaredWriteSet: ["packages/broker/src/core/**"],
    touchedFiles: [
      "packages/broker/src/core/runtime-safety-gates.ts",
      "packages/broker/scripts/claude-a2a-patch-bridge.mjs",
      "AGENTS.md",
    ],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.quarantineRequired, true);
  assert.deepEqual(decision.outOfScopeFiles, [
    "packages/broker/scripts/claude-a2a-patch-bridge.mjs",
    "AGENTS.md",
  ]);
  assert.match(decision.reason, /outside declared write-set/);
});


test("stable idempotency keys ignore retry-only timestamps and block duplicate apply/finalize", () => {
  const firstKey = buildStableRuntimeIdempotencyKey({
    taskId: "task-1",
    runId: "run-1",
    phase: "finalize",
    action: "post_github_evidence",
    target: "https://github.com/jinwon-int/a2a-nexus/issues/1130",
    updatedAt: "2026-06-29T14:00:00.000Z",
  });
  const retryKey = buildStableRuntimeIdempotencyKey({
    taskId: "task-1",
    runId: "run-1",
    phase: "finalize",
    action: "post_github_evidence",
    target: "https://github.com/jinwon-int/a2a-nexus/issues/1130",
    updatedAt: "2026-06-29T14:05:00.000Z",
  });

  assert.equal(firstKey, retryKey);
  assert.equal(evaluateRuntimeReplayGate({ idempotencyKey: firstKey, appliedKeys: [] }).allowed, true);
  const duplicate = evaluateRuntimeReplayGate({ idempotencyKey: retryKey, appliedKeys: [firstKey] });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, "duplicate_idempotency_key");
});

test("worker runtime boundary enforces tunnel-only broker egress and workspace membership", () => {
  const decision = evaluateWorkerRuntimeBoundary({
    tunnelOnly: true,
    brokerUrl: "https://gwakga.example.invalid:8787",
    taskWorkspaceId: "a2a-nexus",
    registeredWorkspaceIds: ["ccc-node"],
    bridgeBin: "claude-a2a-analysis-bridge.mjs",
    reportedMetadata: { runtime: "hermes", adapter: "claimed" },
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.blockers, [
    "tunnel-only worker must use a loopback broker URL",
    "task workspace a2a-nexus is not registered for this worker",
    "runtime metadata must be derived from bridge wiring",
  ]);
  assert.deepEqual(decision.derivedMetadata, {
    runtime: "claude-code",
    harness: "analysis-bridge",
    adapter: "claude-a2a-analysis-bridge",
  });
});

test("worker runtime boundary accepts loopback tunnel and matching workspace", () => {
  const decision = evaluateWorkerRuntimeBoundary({
    tunnelOnly: true,
    brokerUrl: "http://127.0.0.1:18790",
    taskWorkspaceId: "a2a-nexus",
    registeredWorkspaceIds: ["a2a-nexus"],
    bridgeBin: "claude-a2a-patch-bridge.mjs",
    reportedMetadata: { runtime: "claude-code", harness: "patch-bridge", adapter: "claude-a2a-patch-bridge" },
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.derivedMetadata.adapter, "claude-a2a-patch-bridge");
});

test("runtime audit events are structured, bounded, redacted, and carry token/cost accounting", () => {
  const bearerHeader = ["Authorization:", "Bearer", "gh" + "p_syntheticRedactionFixture000000000000000"].join(" ");
  const edgeSecretAssignment = ["EDGE_SECRET", "synthetic" + "SecretValue"].join("=");
  const event = buildRuntimeAuditEvent({
    id: "audit-1",
    taskId: "task-1",
    actorId: "worker-a",
    action: "bridge.spawned",
    message: `${bearerHeader} and ${edgeSecretAssignment}`,
    tokenUsage: { inputTokens: 1000, outputTokens: 250, totalTokens: 1250 },
    costUsd: 0.012345,
    maxMessageChars: 80,
  });

  assert.equal(event.id, "audit-1");
  assert.equal(event.action, "bridge.spawned");
  assert.equal(event.taskId, "task-1");
  assert.equal(event.actorId, "worker-a");
  assert.equal(event.tokenUsage.totalTokens, 1250);
  assert.equal(event.costUsd, 0.012345);
  assert.ok(event.message.length <= 80);
  assert.doesNotMatch(event.message, /ghp_|supersecretvalue|Bearer [A-Za-z0-9_]+/);
  assert.match(event.message, /\[redacted/);
});

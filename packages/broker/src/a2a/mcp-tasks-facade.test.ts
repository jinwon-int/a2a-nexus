// MCP Tasks facade contract v1 (a2a-nexus #2591 G1–G4; #2592 mapping, #2593 operator-decision gate).
// Spec: docs/specs/mcp-tasks-facade.md. Gaps: docs/specs/mcp-tasks-server-design.md §1.2.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { registerWorker } from "../core/broker-test-helpers.js";
import { TERMINAL_TASK_STATUSES } from "../core/types.js";
import type { TaskCheckpointInfo, TaskRecord } from "../core/types.js";
import {
  MCP_CANCEL_BROKER_STATUS,
  MCP_CLARIFICATION_KEY_PREFIX,
  MCP_CLARIFICATION_MAX_LENGTH,
  MCP_OPERATOR_WAIT_POLL_INTERVAL_MS,
  MCP_POLL_INTERVAL_DEFAULT_MS,
  MCP_POLL_INTERVAL_MAX_MS,
  MCP_PROTOCOL_ONLY_STATUSES,
  MCP_STATUS_MESSAGE_MAX_LENGTH,
  MCP_TASKS_CONTRACT_VERSION,
  MCP_TASK_STATUSES,
  McpTaskIdError,
  assertValidMcpTaskId,
  clampPollIntervalMs,
  evaluateMcpTaskInputResponse,
  isValidMcpTaskId,
  mcpClarificationKey,
  mcpInputRequestsForTask,
  mcpToolOutcomeForTask,
  mcpWaitKindForTask,
  projectMcpTask,
  type McpTaskStatus,
  type McpToolOutcome,
  type McpWaitKind,
} from "./mcp-tasks-facade.js";

// Test sources run with the broker package root as the working directory
// (same convention as src/core/terminal-status-canonical.test.ts).
function unionLiterals(typeName: string): string[] {
  const source = readFileSync(join(process.cwd(), "src", "core", "types.ts"), "utf8");
  const match = source.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  assert.ok(match, `${typeName} union not found in src/core/types.ts`);
  return [...new Set([...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!))].sort();
}

type Fields = Pick<TaskRecord, "id" | "createdAt" | "updatedAt" | "status" | "checkpoint" | "approvalOutcome">;

const TASK_ID = "3f2c8a1e-9b4d-4c6e-8a2f-1d3e5b7c9a0b";
const CP_RECORDED_AT = "2026-11-25T00:00:30.000Z";
const CLARIFY_KEY = `${MCP_CLARIFICATION_KEY_PREFIX}cp-1@${CP_RECORDED_AT}`;

function task(overrides: Partial<Fields> = {}): Fields {
  return {
    id: TASK_ID,
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:01:00.000Z",
    status: "running",
    ...overrides,
  };
}

function checkpoint(
  state: TaskCheckpointInfo["state"],
  decisionType?: TaskCheckpointInfo["decisionType"],
  overrides: Partial<TaskCheckpointInfo> = {},
): TaskCheckpointInfo {
  return {
    state,
    checkpointId: "cp-1",
    reason: "SECRET-REASON-TEXT must never surface",
    ...(decisionType ? { decisionType } : {}),
    recordedAt: CP_RECORDED_AT,
    recordedBy: "worker-a",
    ...overrides,
  };
}

const REJECTED = { status: "rejected", approvalId: "ap-1", decidedAt: "2026-11-25T00:02:00.000Z", decidedBy: "operator-a" } as const;

test("contract version is 1", () => {
  assert.equal(MCP_TASKS_CONTRACT_VERSION, 1);
});

// ---------------------------------------------------------------------------
// #2592 — status mapping, exhaustive over the broker vocabulary (v1 table)
// ---------------------------------------------------------------------------

/** Expected MCP status, wait kind and tool outcome per broker status with no checkpoint. */
const EXPECTED_BY_STATUS: Record<string, { status: McpTaskStatus; wait?: McpWaitKind; outcome?: McpToolOutcome }> = {
  blocked: { status: "working", wait: "operator_decision" },
  queued: { status: "working" },
  claimed: { status: "working" },
  running: { status: "working" },
  succeeded: { status: "completed", outcome: { isError: false } },
  failed: { status: "completed", outcome: { isError: true, reason: "broker:failed" } },
  canceled: { status: "cancelled" },
};

/** Expected wait kind per checkpoint decision type on an awaiting_operator checkpoint ("" = none given). */
const EXPECTED_WAIT_BY_DECISION: Record<string, McpWaitKind> = {
  "": "operator_decision",
  ambiguous_scope: "clarification",
  approval_required: "operator_decision",
  safety_gate: "operator_decision",
  conflict_detected: "operator_decision",
};

test("#2592 every broker TaskStatus has an MCP mapping (a new status without one fails here)", () => {
  assert.deepEqual(unionLiterals("TaskStatus"), Object.keys(EXPECTED_BY_STATUS).sort());
  for (const [status, expected] of Object.entries(EXPECTED_BY_STATUS)) {
    const projected = projectMcpTask(task({ status: status as TaskRecord["status"] }));
    assert.equal(projected.status, expected.status, `broker ${status}`);
    assert.equal(projected.waitKind, expected.wait, `broker ${status} wait kind`);
    assert.deepEqual(projected.toolOutcome, expected.outcome, `broker ${status} tool outcome`);
    assert.ok((MCP_TASK_STATUSES as readonly string[]).includes(projected.status));
  }
});

test("#2592 every checkpoint state and decision type has a mapping (new vocabulary fails here)", () => {
  assert.deepEqual(unionLiterals("TaskCheckpointState"), ["awaiting_operator", "paused"]);
  assert.deepEqual(
    unionLiterals("TaskInterruptDecisionType"),
    Object.keys(EXPECTED_WAIT_BY_DECISION).filter(Boolean).sort(),
  );
  for (const status of ["claimed", "running"] as const) {
    // paused is "working" (no MCP paused state), whatever the decision type.
    for (const decision of Object.keys(EXPECTED_WAIT_BY_DECISION)) {
      const paused = projectMcpTask(task({ status, checkpoint: checkpoint("paused", (decision || undefined) as never) }));
      assert.equal(paused.status, "working", `${status}+paused+${decision || "none"}`);
      assert.equal(paused.waitKind, undefined);
    }
    for (const [decision, wait] of Object.entries(EXPECTED_WAIT_BY_DECISION)) {
      const waiting = projectMcpTask(task({ status, checkpoint: checkpoint("awaiting_operator", (decision || undefined) as never) }));
      const label = `${status}+awaiting_operator+${decision || "none"}`;
      assert.equal(waiting.waitKind, wait, `${label} wait kind`);
      // G3: only a clarification is input_required; an operator decision is working.
      assert.equal(waiting.status, wait === "clarification" ? "input_required" : "working", label);
    }
  }
});

// ---------------------------------------------------------------------------
// G1 — `failed` is reserved for protocol errors
// ---------------------------------------------------------------------------

test("G1 projectMcpTask never produces a protocol-only status over the whole broker vocabulary", () => {
  assert.deepEqual([...MCP_PROTOCOL_ONLY_STATUSES], ["failed"]);
  const checkpoints = [undefined, checkpoint("paused"), ...Object.keys(EXPECTED_WAIT_BY_DECISION)
    .map((decision) => checkpoint("awaiting_operator", (decision || undefined) as never))];
  for (const status of unionLiterals("TaskStatus") as TaskRecord["status"][]) {
    for (const cp of checkpoints) {
      for (const approvalOutcome of [undefined, REJECTED]) {
        const projected = projectMcpTask(task({ status, checkpoint: cp, ...(approvalOutcome ? { approvalOutcome } : {}) }));
        assert.ok(!(MCP_PROTOCOL_ONLY_STATUSES as readonly string[]).includes(projected.status), `${status} ${cp?.state ?? ""}`);
      }
    }
  }
});

test("G1 a broker failure is completed + isError with the closed-vocabulary reason", () => {
  const failed = projectMcpTask(task({ status: "failed" }));
  assert.equal(failed.status, "completed");
  assert.deepEqual(failed.toolOutcome, { isError: true, reason: "broker:failed" });
  assert.match(failed.statusMessage, /broker:failed/);
  assert.deepEqual(projectMcpTask(task({ status: "succeeded" })).toolOutcome, { isError: false });
});

test("G1 an operator rejection (canceled + approvalOutcome rejected) is completed + isError, a plain cancel is cancelled", () => {
  const rejected = projectMcpTask(task({ status: "canceled", approvalOutcome: REJECTED }));
  assert.equal(rejected.status, "completed");
  assert.deepEqual(rejected.toolOutcome, { isError: true, reason: "approval:rejected" });
  assert.match(rejected.statusMessage, /approval:rejected/);
  const cancelled = projectMcpTask(task({ status: "canceled" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.toolOutcome, undefined);
});

test("G1 tool outcome exists only for completed tasks", () => {
  for (const status of ["blocked", "queued", "claimed", "running", "canceled"] as const) {
    assert.equal(mcpToolOutcomeForTask(task({ status })), undefined, status);
  }
});

test("#2592 cancel spelling: MCP 'cancelled' out, broker 'canceled' back, and that status is terminal", () => {
  assert.equal(projectMcpTask(task({ status: "canceled" })).status, "cancelled");
  assert.equal(MCP_CANCEL_BROKER_STATUS, "canceled");
  assert.ok((TERMINAL_TASK_STATUSES as readonly string[]).includes(MCP_CANCEL_BROKER_STATUS));
  assert.ok(!(MCP_TASK_STATUSES as readonly string[]).includes("canceled"));
});

test("#2592 projection carries timestamps, null ttl, clamped poll interval", () => {
  const projected = projectMcpTask(task(), { pollIntervalMs: 10 });
  assert.equal(projected.taskId, TASK_ID);
  assert.equal(projected.createdAt, "2026-11-25T00:00:00.000Z");
  assert.equal(projected.lastUpdatedAt, "2026-11-25T00:01:00.000Z");
  assert.equal(projected.ttlMs, null);
  assert.equal(projected.pollIntervalMs, 250);
  assert.equal(clampPollIntervalMs(999_999), 30_000);
  assert.equal(clampPollIntervalMs(undefined), MCP_POLL_INTERVAL_DEFAULT_MS);
  assert.equal(clampPollIntervalMs(Number.NaN), MCP_POLL_INTERVAL_DEFAULT_MS);
  assert.equal(clampPollIntervalMs(1234.6), 1235);
});

// ---------------------------------------------------------------------------
// G4 — only broker-assigned version-4 UUIDs are exposed
// ---------------------------------------------------------------------------

test("G4 taskId: a broker-assigned lowercase v4 UUID is carried verbatim", () => {
  for (let i = 0; i < 32; i += 1) {
    const id = randomUUID();
    assert.equal(assertValidMcpTaskId(id), id);
    assert.equal(projectMcpTask(task({ id })).taskId, id);
  }
});

test("G4 taskId: caller-chosen, guessable, or non-canonical ids are rejected (never rewritten)", () => {
  const bad = [
    "",
    "task-0001",                                   // REST POST /tasks caller-chosen id (valid in v0)
    "task 01~",                                    // printable ASCII (valid in v0)
    "a".repeat(128),                               // v0 max length
    TASK_ID.toUpperCase(),                         // not canonical lowercase
    `{${TASK_ID}}`,
    TASK_ID.replace(/-/g, ""),
    "3f2c8a1e-9b4d-1c6e-8a2f-1d3e5b7c9a0b",        // version 1 (time-based)
    "3f2c8a1e-9b4d-7c6e-8a2f-1d3e5b7c9a0b",        // version 7 (time-ordered)
    "3f2c8a1e-9b4d-4c6e-ca2f-1d3e5b7c9a0b",        // wrong variant
    "00000000-0000-0000-0000-000000000000",
    `${TASK_ID}\n`,
    "태스크",
  ];
  for (const id of bad) {
    assert.equal(isValidMcpTaskId(id), false, JSON.stringify(id));
    assert.throws(() => projectMcpTask(task({ id })), McpTaskIdError, JSON.stringify(id));
  }
  assert.equal(isValidMcpTaskId(undefined), false);
  assert.equal(isValidMcpTaskId(42), false);
});

test("G4 a task created through the broker without a caller id is exposable", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  const created = broker.createTask({
    intent: "analyze",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "read-only analysis",
  });
  assert.equal(isValidMcpTaskId(created.id), true, created.id);
});

test("#2592 statusMessage is closed-vocabulary tokens only (no checkpoint reason text) and length-capped", () => {
  const projected = projectMcpTask(task({ checkpoint: checkpoint("awaiting_operator", "safety_gate") }));
  assert.equal(projected.statusMessage, "broker:running checkpoint:awaiting_operator decision:safety_gate");
  assert.doesNotMatch(projected.statusMessage, /SECRET/);
  assert.ok(projected.statusMessage.length <= MCP_STATUS_MESSAGE_MAX_LENGTH);
});

// ---------------------------------------------------------------------------
// G2 — inputRequests keys are unique over the task's lifetime
// ---------------------------------------------------------------------------

test("G2 a clarification key binds the checkpoint id and its recordedAt", () => {
  const waiting = task({ checkpoint: checkpoint("awaiting_operator", "ambiguous_scope") });
  assert.equal(mcpClarificationKey(waiting.checkpoint), CLARIFY_KEY);
  const requests = mcpInputRequestsForTask(waiting);
  assert.deepEqual(Object.keys(requests!), [CLARIFY_KEY]);
  assert.equal(requests![CLARIFY_KEY]!.params.mode, "form");
  assert.doesNotMatch(JSON.stringify(requests), /SECRET/);
  // The v0 fixed key is gone.
  assert.ok(!("clarification" in requests!));
});

test("G2 a later checkpoint gets a new key even when the worker reuses its checkpoint id", () => {
  const first = checkpoint("awaiting_operator", "ambiguous_scope");
  const second = checkpoint("awaiting_operator", "ambiguous_scope", { recordedAt: "2026-11-25T00:05:00.000Z" });
  const renamed = checkpoint("awaiting_operator", "ambiguous_scope", { checkpointId: "cp-2" });
  const keys = new Set([first, second, renamed].map((cp) => mcpClarificationKey(cp)));
  assert.equal(keys.size, 3);
  // An answer to the earlier (resolved) checkpoint's key does not satisfy the new one.
  const answer = { [mcpClarificationKey(first)!]: { action: "accept", content: { text: "use staging" } } };
  assert.deepEqual(
    evaluateMcpTaskInputResponse(task({ checkpoint: second }), answer),
    { accepted: false, reason: "unexpected_keys" },
  );
});

test("G2 a checkpoint that cannot be keyed safely fails closed to an operator wait", () => {
  for (const overrides of [{ checkpointId: "" }, { checkpointId: "cp@1" }, { checkpointId: "x".repeat(129) }, { recordedAt: "not-a-date" }]) {
    const waiting = task({ checkpoint: checkpoint("awaiting_operator", "ambiguous_scope", overrides) });
    assert.equal(mcpClarificationKey(waiting.checkpoint), undefined, JSON.stringify(overrides));
    assert.equal(mcpWaitKindForTask(waiting), "operator_decision");
    assert.equal(projectMcpTask(waiting).status, "working");
    assert.equal(mcpInputRequestsForTask(waiting), undefined);
  }
});

// ---------------------------------------------------------------------------
// G3 — operator-decision waits are working, with no inputRequests
// ---------------------------------------------------------------------------

const OPERATOR_DECISION_TASKS: Array<[string, Fields]> = [
  ["blocked (approval-gated)", task({ status: "blocked" })],
  ["awaiting_operator approval_required", task({ checkpoint: checkpoint("awaiting_operator", "approval_required") })],
  ["awaiting_operator safety_gate", task({ checkpoint: checkpoint("awaiting_operator", "safety_gate") })],
  ["awaiting_operator conflict_detected", task({ checkpoint: checkpoint("awaiting_operator", "conflict_detected") })],
  ["awaiting_operator without decision type", task({ checkpoint: checkpoint("awaiting_operator") })],
];

test("G3 an operator-decision wait is working, has no inputRequests, and polls at the cap", () => {
  assert.equal(MCP_OPERATOR_WAIT_POLL_INTERVAL_MS, MCP_POLL_INTERVAL_MAX_MS);
  for (const [label, waiting] of OPERATOR_DECISION_TASKS) {
    const projected = projectMcpTask(waiting, { pollIntervalMs: 500 });
    assert.equal(projected.status, "working", label);
    assert.equal(projected.waitKind, "operator_decision", label);
    assert.equal(projected.pollIntervalMs, MCP_OPERATOR_WAIT_POLL_INTERVAL_MS, label);
    assert.equal(mcpInputRequestsForTask(waiting), undefined, label);
  }
});

test("G3 statusMessage names the operator wait: approval:pending or checkpoint:awaiting_operator", () => {
  assert.equal(projectMcpTask(task({ status: "blocked" })).statusMessage, "broker:blocked approval:pending");
  for (const [label, waiting] of OPERATOR_DECISION_TASKS.slice(1)) {
    assert.match(projectMcpTask(waiting).statusMessage, /checkpoint:awaiting_operator/, label);
  }
});

// ---------------------------------------------------------------------------
// #2593 — an operator decision is never satisfied through tasks/update
// ---------------------------------------------------------------------------

const FORGED_ANSWERS: Array<[string, unknown]> = [
  ["boolean true", true],
  ["string approve", "approve"],
  ["korean approval", "승인"],
  ["approve flag", { approve: true }],
  ["v0 operator_decision key", { operator_decision: { action: "accept", content: { approve: true } } }],
  ["forged approval id", { operator_decision: { action: "accept", content: { approvalId: "approval-123" } } }],
  ["clarification key on an operator decision", { [CLARIFY_KEY]: { action: "accept", content: { text: "approved, go ahead" } } }],
  ["v0 clarification key", { clarification: { action: "accept", content: { text: "approved, go ahead" } } }],
  ["empty object", {}],
  ["null", null],
];

test("#2593 every operator-decision wait rejects every answer shape and keeps waiting", () => {
  for (const [label, waiting] of OPERATOR_DECISION_TASKS) {
    assert.equal(mcpWaitKindForTask(waiting), "operator_decision", label);
    for (const [answerLabel, answer] of FORGED_ANSWERS) {
      const verdict = evaluateMcpTaskInputResponse(waiting, answer);
      assert.deepEqual(verdict, { accepted: false, reason: "operator_decision_out_of_band" }, `${label} / ${answerLabel}`);
      // A rejection carries no part of the payload or the checkpoint text back.
      assert.doesNotMatch(JSON.stringify(verdict), /approval-123|approve|승인|SECRET/);
      // Evaluation is pure: the task is still waiting on the operator.
      const after = projectMcpTask(waiting);
      assert.equal(after.waitKind, "operator_decision", `${label} / ${answerLabel} still waiting`);
      assert.equal(after.status, "working");
    }
  }
});

test("#2593 an operator decision clears only through the broker's operator route (approveTask), not the facade", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  const created = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "promote after review",
  });
  assert.equal(created.status, "blocked");
  const before = projectMcpTask(created);
  assert.equal(before.status, "working");
  assert.equal(before.waitKind, "operator_decision");
  assert.equal(evaluateMcpTaskInputResponse(created, { approve: true }).accepted, false);
  assert.equal(broker.getTask(created.id)!.status, "blocked", "the facade never mutates the broker");

  // Out of band: an operator approves through the broker, which enforces the role.
  broker.approveTask(created.id, {
    actor: { id: "operator-a", kind: "node", role: "operator" },
    approvalId: "approval-123",
    reason: "reviewed",
  });
  const after = projectMcpTask(broker.getTask(created.id)!);
  assert.equal(after.status, "working");
  assert.equal(after.waitKind, undefined);
});

test("#2593 clarification accepts exactly one well-formed accepted text answer on the outstanding key", () => {
  const waiting = task({ checkpoint: checkpoint("awaiting_operator", "ambiguous_scope") });
  assert.equal(projectMcpTask(waiting).status, "input_required");
  const key = CLARIFY_KEY;
  assert.deepEqual(
    evaluateMcpTaskInputResponse(waiting, { [key]: { action: "accept", content: { text: "  use the staging branch  " } } }),
    { accepted: true, kind: "clarification", key, text: "use the staging branch" },
  );
  const cases: Array<[unknown, string]> = [
    [{ [key]: { action: "decline" } }, "declined"],
    [{ [key]: { action: "cancel" } }, "declined"],
    [{ [key]: { action: "accept", content: { text: "   " } } }, "invalid_clarification"],
    [{ [key]: { action: "accept", content: { text: "x".repeat(MCP_CLARIFICATION_MAX_LENGTH + 1) } } }, "invalid_clarification"],
    [{ [key]: { action: "accept", content: { text: 42 } } }, "invalid_clarification"],
    [{ [key]: { action: "accept", content: { text: "ok" } }, extra: {} }, "unexpected_keys"],
    [{ clarification: { action: "accept", content: { text: "ok" } } }, "unexpected_keys"],
    [{ operator_decision: { action: "accept", content: { text: "ok" } } }, "unexpected_keys"],
    [{}, "missing_response"],
    ["just text", "missing_response"],
  ];
  for (const [answer, reason] of cases) {
    assert.deepEqual(evaluateMcpTaskInputResponse(waiting, answer), { accepted: false, reason }, JSON.stringify(answer).slice(0, 80));
  }
});

test("#2593 a task that is not waiting for input accepts nothing", () => {
  for (const status of ["queued", "running", "succeeded", "failed", "canceled"] as const) {
    assert.deepEqual(
      evaluateMcpTaskInputResponse(task({ status }), { [CLARIFY_KEY]: { action: "accept", content: { text: "x" } } }),
      { accepted: false, reason: "not_input_required" },
      status,
    );
  }
});

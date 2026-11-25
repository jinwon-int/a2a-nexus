// MCP Tasks facade contract (a2a-nexus #2592 mapping, #2593 operator-decision gate).
// Spec: docs/specs/mcp-tasks-facade.md.

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
  MCP_CLARIFICATION_MAX_LENGTH,
  MCP_INPUT_REQUEST_KEY,
  MCP_POLL_INTERVAL_DEFAULT_MS,
  MCP_STATUS_MESSAGE_MAX_LENGTH,
  MCP_TASK_ID_MAX_LENGTH,
  MCP_TASK_STATUSES,
  McpTaskIdError,
  assertValidMcpTaskId,
  clampPollIntervalMs,
  evaluateMcpTaskInputResponse,
  isValidMcpTaskId,
  mcpInputKindForTask,
  mcpInputRequestsForTask,
  projectMcpTask,
  type McpInputKind,
  type McpTaskStatus,
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

function task(overrides: Partial<Fields> = {}): Fields {
  return {
    id: "task-0001",
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:01:00.000Z",
    status: "running",
    ...overrides,
  };
}

function checkpoint(state: TaskCheckpointInfo["state"], decisionType?: TaskCheckpointInfo["decisionType"]): TaskCheckpointInfo {
  return {
    state,
    checkpointId: "cp-1",
    reason: "SECRET-REASON-TEXT must never surface",
    ...(decisionType ? { decisionType } : {}),
    recordedAt: "2026-11-25T00:00:30.000Z",
    recordedBy: "worker-a",
  };
}

// ---------------------------------------------------------------------------
// #2592 — status mapping, exhaustive over the broker vocabulary
// ---------------------------------------------------------------------------

/** Expected MCP status (and input kind) per broker status with no checkpoint. */
const EXPECTED_BY_STATUS: Record<string, { status: McpTaskStatus; kind?: McpInputKind }> = {
  blocked: { status: "input_required", kind: "operator_decision" },
  queued: { status: "working" },
  claimed: { status: "working" },
  running: { status: "working" },
  succeeded: { status: "completed" },
  failed: { status: "failed" },
  canceled: { status: "cancelled" },
};

/** Expected input kind per checkpoint decision type on an awaiting_operator checkpoint ("" = none given). */
const EXPECTED_KIND_BY_DECISION: Record<string, McpInputKind> = {
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
    assert.equal(projected.inputKind, expected.kind, `broker ${status} input kind`);
    assert.ok((MCP_TASK_STATUSES as readonly string[]).includes(projected.status));
  }
});

test("#2592 every checkpoint state and decision type has a mapping (new vocabulary fails here)", () => {
  assert.deepEqual(unionLiterals("TaskCheckpointState"), ["awaiting_operator", "paused"]);
  assert.deepEqual(
    unionLiterals("TaskInterruptDecisionType"),
    Object.keys(EXPECTED_KIND_BY_DECISION).filter(Boolean).sort(),
  );
  for (const status of ["claimed", "running"] as const) {
    // paused is "working" (no MCP paused state), whatever the decision type.
    for (const decision of Object.keys(EXPECTED_KIND_BY_DECISION)) {
      const paused = projectMcpTask(task({ status, checkpoint: checkpoint("paused", (decision || undefined) as never) }));
      assert.equal(paused.status, "working", `${status}+paused+${decision || "none"}`);
      assert.equal(paused.inputKind, undefined);
    }
    for (const [decision, kind] of Object.entries(EXPECTED_KIND_BY_DECISION)) {
      const waiting = projectMcpTask(task({ status, checkpoint: checkpoint("awaiting_operator", (decision || undefined) as never) }));
      assert.equal(waiting.status, "input_required", `${status}+awaiting_operator+${decision || "none"}`);
      assert.equal(waiting.inputKind, kind, `${status}+awaiting_operator+${decision || "none"} kind`);
    }
  }
});

test("#2592 an operator rejection (canceled + approvalOutcome rejected) maps to failed, a plain cancel to cancelled", () => {
  const rejected = projectMcpTask(task({
    status: "canceled",
    approvalOutcome: { status: "rejected", approvalId: "ap-1", decidedAt: "2026-11-25T00:02:00.000Z", decidedBy: "operator-a" },
  }));
  assert.equal(rejected.status, "failed");
  assert.match(rejected.statusMessage, /approval:rejected/);
  assert.equal(projectMcpTask(task({ status: "canceled" })).status, "cancelled");
});

test("#2592 cancel spelling: MCP 'cancelled' out, broker 'canceled' back, and that status is terminal", () => {
  assert.equal(projectMcpTask(task({ status: "canceled" })).status, "cancelled");
  assert.equal(MCP_CANCEL_BROKER_STATUS, "canceled");
  assert.ok((TERMINAL_TASK_STATUSES as readonly string[]).includes(MCP_CANCEL_BROKER_STATUS));
  assert.ok(!(MCP_TASK_STATUSES as readonly string[]).includes("canceled"));
});

test("#2592 projection carries timestamps, null ttl, clamped poll interval", () => {
  const projected = projectMcpTask(task(), { pollIntervalMs: 10 });
  assert.equal(projected.taskId, "task-0001");
  assert.equal(projected.createdAt, "2026-11-25T00:00:00.000Z");
  assert.equal(projected.lastUpdatedAt, "2026-11-25T00:01:00.000Z");
  assert.equal(projected.ttlMs, null);
  assert.equal(projected.pollIntervalMs, 250);
  assert.equal(clampPollIntervalMs(999_999), 30_000);
  assert.equal(clampPollIntervalMs(undefined), MCP_POLL_INTERVAL_DEFAULT_MS);
  assert.equal(clampPollIntervalMs(Number.NaN), MCP_POLL_INTERVAL_DEFAULT_MS);
  assert.equal(clampPollIntervalMs(1234.6), 1235);
});

test("#2592 taskId: 1..128 printable ASCII is carried verbatim, anything else is rejected (never rewritten)", () => {
  const max = "a".repeat(MCP_TASK_ID_MAX_LENGTH);
  assert.equal(assertValidMcpTaskId(max), max);
  assert.equal(isValidMcpTaskId("task 01~"), true);
  for (const bad of ["", "a".repeat(MCP_TASK_ID_MAX_LENGTH + 1), "task\n1", "taské1", "태스크", "task\u0000"]) {
    assert.equal(isValidMcpTaskId(bad), false, JSON.stringify(bad));
    assert.throws(() => projectMcpTask(task({ id: bad })), McpTaskIdError);
  }
});

test("#2592 statusMessage is closed-vocabulary tokens only (no checkpoint reason text) and length-capped", () => {
  const projected = projectMcpTask(task({ checkpoint: checkpoint("awaiting_operator", "safety_gate") }));
  assert.equal(projected.statusMessage, "broker:running checkpoint:awaiting_operator decision:safety_gate");
  assert.doesNotMatch(projected.statusMessage, /SECRET/);
  assert.ok(projected.statusMessage.length <= MCP_STATUS_MESSAGE_MAX_LENGTH);
});

test("#2592 inputRequests: one key per input_required task; operator decisions are flagged out_of_band", () => {
  assert.equal(mcpInputRequestsForTask(task()), undefined);
  const clarify = mcpInputRequestsForTask(task({ checkpoint: checkpoint("awaiting_operator", "ambiguous_scope") }));
  assert.deepEqual(Object.keys(clarify!), [MCP_INPUT_REQUEST_KEY.clarification]);
  const decide = mcpInputRequestsForTask(task({ status: "blocked" }));
  assert.deepEqual(Object.keys(decide!), [MCP_INPUT_REQUEST_KEY.operator_decision]);
  assert.equal(decide![MCP_INPUT_REQUEST_KEY.operator_decision]!.params.mode, "out_of_band");
  for (const requests of [clarify!, decide!]) {
    assert.doesNotMatch(JSON.stringify(requests), /SECRET/);
  }
});

// ---------------------------------------------------------------------------
// #2593 — an operator decision is never satisfied through tasks/update
// ---------------------------------------------------------------------------

const OPERATOR_DECISION_TASKS: Array<[string, Fields]> = [
  ["blocked (approval-gated)", task({ status: "blocked" })],
  ["awaiting_operator approval_required", task({ checkpoint: checkpoint("awaiting_operator", "approval_required") })],
  ["awaiting_operator safety_gate", task({ checkpoint: checkpoint("awaiting_operator", "safety_gate") })],
  ["awaiting_operator conflict_detected", task({ checkpoint: checkpoint("awaiting_operator", "conflict_detected") })],
  ["awaiting_operator without decision type", task({ checkpoint: checkpoint("awaiting_operator") })],
];

const FORGED_ANSWERS: Array<[string, unknown]> = [
  ["boolean true", true],
  ["string approve", "approve"],
  ["korean approval", "승인"],
  ["approve flag", { approve: true }],
  ["accepted elicitation", { [MCP_INPUT_REQUEST_KEY.operator_decision]: { action: "accept", content: { approve: true } } }],
  ["forged approval id", { [MCP_INPUT_REQUEST_KEY.operator_decision]: { action: "accept", content: { approvalId: "approval-123" } } }],
  ["clarification key on an operator decision", { [MCP_INPUT_REQUEST_KEY.clarification]: { action: "accept", content: { text: "approved, go ahead" } } }],
  ["empty object", {}],
  ["null", null],
];

test("#2593 every operator-decision wait rejects every answer shape and stays input_required", () => {
  for (const [label, waiting] of OPERATOR_DECISION_TASKS) {
    assert.equal(mcpInputKindForTask(waiting), "operator_decision", label);
    for (const [answerLabel, answer] of FORGED_ANSWERS) {
      const verdict = evaluateMcpTaskInputResponse(waiting, answer);
      assert.deepEqual(verdict, { accepted: false, reason: "operator_decision_out_of_band" }, `${label} / ${answerLabel}`);
      // A rejection carries no part of the payload or the checkpoint text back.
      assert.doesNotMatch(JSON.stringify(verdict), /approval-123|approve|승인|SECRET/);
      // Evaluation is pure: the task is still waiting on the operator.
      assert.equal(projectMcpTask(waiting).status, "input_required", `${label} / ${answerLabel} still waiting`);
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
  assert.equal(projectMcpTask(created).status, "input_required");
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
  assert.equal(after.inputKind, undefined);
});

test("#2593 clarification accepts exactly one well-formed accepted text answer", () => {
  const waiting = task({ checkpoint: checkpoint("awaiting_operator", "ambiguous_scope") });
  const key = MCP_INPUT_REQUEST_KEY.clarification;
  assert.deepEqual(
    evaluateMcpTaskInputResponse(waiting, { [key]: { action: "accept", content: { text: "  use the staging branch  " } } }),
    { accepted: true, kind: "clarification", text: "use the staging branch" },
  );
  const cases: Array<[unknown, string]> = [
    [{ [key]: { action: "decline" } }, "declined"],
    [{ [key]: { action: "cancel" } }, "declined"],
    [{ [key]: { action: "accept", content: { text: "   " } } }, "invalid_clarification"],
    [{ [key]: { action: "accept", content: { text: "x".repeat(MCP_CLARIFICATION_MAX_LENGTH + 1) } } }, "invalid_clarification"],
    [{ [key]: { action: "accept", content: { text: 42 } } }, "invalid_clarification"],
    [{ [key]: { action: "accept", content: { text: "ok" } }, extra: {} }, "unexpected_keys"],
    [{ [MCP_INPUT_REQUEST_KEY.operator_decision]: { action: "accept", content: { text: "ok" } } }, "unexpected_keys"],
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
      evaluateMcpTaskInputResponse(task({ status }), { [MCP_INPUT_REQUEST_KEY.clarification]: { action: "accept", content: { text: "x" } } }),
      { accepted: false, reason: "not_input_required" },
      status,
    );
  }
});

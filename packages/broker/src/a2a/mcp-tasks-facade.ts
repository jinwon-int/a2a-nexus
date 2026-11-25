/**
 * MCP Tasks facade — pure mapping contract (a2a-nexus #2591 / #2592 / #2593).
 *
 * Projects a broker task onto the MCP Tasks wire shape (MCP spec 2026-07-28,
 * Claude Code GA 2026-11-24) and classifies `tasks/update` input responses.
 * Spec: docs/specs/mcp-tasks-facade.md.
 *
 * Pure functions only: no network, no persistence, no broker mutation. A
 * later live adapter calls these and must not re-derive the mapping.
 *
 * The MCP status is derived from the existing A2A projection
 * ({@link mapTaskState}) so the two protocol faces cannot drift apart.
 */
import type { TaskCheckpointInfo, TaskInterruptDecisionType, TaskRecord } from "../core/types.js";
import { mapTaskState, type A2ATaskState } from "./task-projection.js";

export const MCP_TASK_STATUSES = ["working", "input_required", "completed", "failed", "cancelled"] as const;
export type McpTaskStatus = (typeof MCP_TASK_STATUSES)[number];

/** Broker status an MCP cancel request maps to. MCP spells it `cancelled`, the broker and A2A `canceled`. */
export const MCP_CANCEL_BROKER_STATUS = "canceled" as const satisfies TaskRecord["status"];

export const MCP_TASK_ID_MAX_LENGTH = 128;
export const MCP_POLL_INTERVAL_MIN_MS = 250;
export const MCP_POLL_INTERVAL_MAX_MS = 30_000;
export const MCP_POLL_INTERVAL_DEFAULT_MS = 2_000;
export const MCP_STATUS_MESSAGE_MAX_LENGTH = 160;
export const MCP_CLARIFICATION_MAX_LENGTH = 4_000;

/**
 * Why an MCP task is waiting for input.
 *
 * - `clarification`: the worker asked the requester to resolve ambiguous
 *   instructions (`ambiguous_scope`). A free-text answer is the input.
 * - `operator_decision`: an approval-gated (`blocked`) task, or a checkpoint
 *   whose decision belongs to an operator (`approval_required`,
 *   `safety_gate`, `conflict_detected`, or no decision type — the broker
 *   defaults that to `approval_required`). This is never answerable through
 *   `tasks/update`; see {@link evaluateMcpTaskInputResponse}.
 */
export type McpInputKind = "clarification" | "operator_decision";

/** The single `inputRequests` key the facade emits for each input kind. */
export const MCP_INPUT_REQUEST_KEY: Readonly<Record<McpInputKind, string>> = Object.freeze({
  clarification: "clarification",
  operator_decision: "operator_decision",
});

/** Only this decision type accepts a requester answer; every other one is an operator decision (deny by default). */
const CLARIFICATION_DECISION_TYPES: ReadonlySet<TaskInterruptDecisionType> = new Set(["ambiguous_scope"]);

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  /** Closed-vocabulary tokens only (broker status, checkpoint state, decision type); never task text. */
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  /** The broker does not expire tasks on a TTL. */
  ttlMs: null;
  pollIntervalMs: number;
  /** Present only when `status === "input_required"`. */
  inputKind?: McpInputKind;
}

export class McpTaskIdError extends Error {
  constructor(reason: string) {
    super(`broker task id is not a valid MCP taskId: ${reason}`);
    this.name = "McpTaskIdError";
  }
}

/** 1..128 printable ASCII characters (0x20-0x7E). */
export function isValidMcpTaskId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 1 && id.length <= MCP_TASK_ID_MAX_LENGTH && /^[\x20-\x7e]+$/.test(id);
}

/** Rejects (never rewrites) a broker id that is not a valid MCP taskId, so the id stays a lossless reference. */
export function assertValidMcpTaskId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new McpTaskIdError("empty");
  if (id.length > MCP_TASK_ID_MAX_LENGTH) throw new McpTaskIdError(`longer than ${MCP_TASK_ID_MAX_LENGTH}`);
  if (!/^[\x20-\x7e]+$/.test(id)) throw new McpTaskIdError("non-printable or non-ASCII character");
  return id;
}

export function clampPollIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MCP_POLL_INTERVAL_DEFAULT_MS;
  return Math.min(MCP_POLL_INTERVAL_MAX_MS, Math.max(MCP_POLL_INTERVAL_MIN_MS, Math.round(value)));
}

/** Exhaustive A2A → MCP status mapping; a new A2A state fails to compile here. */
export function mcpTaskStatusForA2AState(state: A2ATaskState): McpTaskStatus {
  switch (state) {
    case "submitted":
    case "working":
      return "working";
    case "input-required":
    case "auth-required":
      return "input_required";
    case "completed":
      return "completed";
    case "failed":
    case "rejected":
      return "failed";
    case "canceled":
      return "cancelled";
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled A2A task state: ${String(unhandled)}`);
    }
  }
}

type TaskStateFields = Pick<TaskRecord, "status" | "approvalOutcome" | "checkpoint">;

export function mcpTaskStatusForTask(task: TaskStateFields): McpTaskStatus {
  return mcpTaskStatusForA2AState(mapTaskState(task));
}

function checkpointInputKind(checkpoint: TaskCheckpointInfo): McpInputKind {
  return checkpoint.decisionType && CLARIFICATION_DECISION_TYPES.has(checkpoint.decisionType)
    ? "clarification"
    : "operator_decision";
}

/** Input kind for an `input_required` task, or `undefined` when the task is not waiting for input. */
export function mcpInputKindForTask(task: TaskStateFields): McpInputKind | undefined {
  if (mcpTaskStatusForTask(task) !== "input_required") return undefined;
  if (task.status === "blocked") return "operator_decision";
  if (task.checkpoint?.state === "awaiting_operator") return checkpointInputKind(task.checkpoint);
  // input_required with neither source cannot happen with the current
  // projection; fail closed to the stricter kind if it ever does.
  return "operator_decision";
}

function statusMessageFor(task: TaskStateFields): string {
  const tokens = [`broker:${task.status}`];
  if (task.checkpoint) {
    tokens.push(`checkpoint:${task.checkpoint.state}`);
    if (task.checkpoint.decisionType) tokens.push(`decision:${task.checkpoint.decisionType}`);
  }
  if (task.approvalOutcome?.status) tokens.push(`approval:${task.approvalOutcome.status}`);
  return tokens.join(" ").slice(0, MCP_STATUS_MESSAGE_MAX_LENGTH);
}

export interface ProjectMcpTaskOptions {
  pollIntervalMs?: number;
}

/** Projects a broker task onto the MCP Task shape. Throws {@link McpTaskIdError} for an id MCP cannot carry. */
export function projectMcpTask(
  task: TaskStateFields & Pick<TaskRecord, "id" | "createdAt" | "updatedAt">,
  options: ProjectMcpTaskOptions = {},
): McpTask {
  const status = mcpTaskStatusForTask(task);
  const projected: McpTask = {
    taskId: assertValidMcpTaskId(task.id),
    status,
    statusMessage: statusMessageFor(task),
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ttlMs: null,
    pollIntervalMs: clampPollIntervalMs(options.pollIntervalMs),
  };
  const inputKind = mcpInputKindForTask(task);
  if (inputKind) projected.inputKind = inputKind;
  return projected;
}

/** MCP `inputRequests` for an `input_required` task (one key per task), or `undefined`. */
export function mcpInputRequestsForTask(
  task: TaskStateFields,
): Record<string, { method: "elicitation/create"; params: { message: string; mode: "form" | "out_of_band" } }> | undefined {
  const kind = mcpInputKindForTask(task);
  if (!kind) return undefined;
  if (kind === "clarification") {
    return {
      [MCP_INPUT_REQUEST_KEY.clarification]: {
        method: "elicitation/create",
        params: { message: "The worker needs clarification of the task instructions.", mode: "form" },
      },
    };
  }
  return {
    [MCP_INPUT_REQUEST_KEY.operator_decision]: {
      method: "elicitation/create",
      params: {
        message: "An operator decision is required. It is recorded through the broker's operator approval route, not through this task.",
        mode: "out_of_band",
      },
    },
  };
}

export type McpInputRejectReason =
  | "not_input_required"
  | "operator_decision_out_of_band"
  | "unexpected_keys"
  | "missing_response"
  | "declined"
  | "invalid_clarification";

export type McpInputEvaluation =
  | { accepted: true; kind: "clarification"; text: string }
  | { accepted: false; reason: McpInputRejectReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classifies a `tasks/update { taskId, inputResponses }` request.
 *
 * Security contract (#2593): an `operator_decision` wait is NEVER satisfied
 * here, whatever the payload — `true`, `"approve"`, `"승인"`, a forged
 * approval id, or a well-formed elicitation result. In an unattended session
 * the MCP client (and so the model) fills `inputResponses` itself, so
 * accepting any answer would let the player act as the judge. The only way
 * past an operator decision is the broker's own operator route
 * (`approveTask` / the operator checkpoint decision); the MCP status then
 * changes on the next `tasks/get`. Rejections echo no part of the payload.
 *
 * Only `clarification` accepts input: exactly the one emitted key, an
 * elicitation result with `action: "accept"` and a non-empty `content.text`
 * of at most {@link MCP_CLARIFICATION_MAX_LENGTH} characters.
 */
export function evaluateMcpTaskInputResponse(task: TaskStateFields, inputResponses: unknown): McpInputEvaluation {
  const kind = mcpInputKindForTask(task);
  if (!kind) return { accepted: false, reason: "not_input_required" };
  if (kind === "operator_decision") return { accepted: false, reason: "operator_decision_out_of_band" };

  if (!isRecord(inputResponses)) return { accepted: false, reason: "missing_response" };
  const key = MCP_INPUT_REQUEST_KEY.clarification;
  const keys = Object.keys(inputResponses);
  if (keys.some((name) => name !== key)) return { accepted: false, reason: "unexpected_keys" };
  const response = inputResponses[key];
  if (!isRecord(response)) return { accepted: false, reason: "missing_response" };
  if (response.action !== "accept") return { accepted: false, reason: "declined" };
  const content = response.content;
  const text = isRecord(content) && typeof content.text === "string" ? content.text.trim() : "";
  if (!text || text.length > MCP_CLARIFICATION_MAX_LENGTH) return { accepted: false, reason: "invalid_clarification" };
  return { accepted: true, kind: "clarification", text };
}

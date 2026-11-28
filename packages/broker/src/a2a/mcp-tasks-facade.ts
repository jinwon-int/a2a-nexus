/**
 * MCP Tasks facade — pure mapping contract v1 (a2a-nexus #2591 / #2592 / #2593).
 *
 * Projects a broker task onto the MCP Tasks wire shape (extension
 * `io.modelcontextprotocol/tasks`, revision 2026-07-28) and classifies
 * `tasks/update` input responses. Spec: docs/specs/mcp-tasks-facade.md.
 * Contract v1 closes the gaps G1–G4 found when v0 was re-checked against the
 * extension text (docs/specs/mcp-tasks-server-design.md §1.2).
 *
 * Pure functions only: no network, no persistence, no broker mutation. A
 * later live adapter calls these and must not re-derive the mapping.
 *
 * The MCP status is derived from the existing A2A projection
 * ({@link mapTaskState}) so the two protocol faces cannot drift apart.
 */
import type { TaskRecord } from "../core/types.js";
import { isOperatorDecisionCheckpoint } from "../core/execution/broker-task-checkpoint.js";
import { mapTaskState } from "./task-projection.js";

export const MCP_TASKS_CONTRACT_VERSION = 1 as const;

export const MCP_TASK_STATUSES = ["working", "input_required", "completed", "failed", "cancelled"] as const;
export type McpTaskStatus = (typeof MCP_TASK_STATUSES)[number];

/**
 * G1: statuses {@link projectMcpTask} never produces. The extension reserves
 * `failed` for a JSON-RPC error during execution, so only the server's own
 * broker call failing at the protocol level (for example the broker rejecting
 * `SendMessage`, or `-32603`) may report it. A task that ran and failed is a
 * tool-level failure and is reported as `completed` with `isError: true`.
 */
export const MCP_PROTOCOL_ONLY_STATUSES = ["failed"] as const satisfies readonly McpTaskStatus[];

/** Broker status an MCP cancel request maps to. MCP spells it `cancelled`, the broker and A2A `canceled`. */
export const MCP_CANCEL_BROKER_STATUS = "canceled" as const satisfies TaskRecord["status"];

/**
 * G4: the only task id form the facade exposes — a lowercase RFC 9562
 * version-4 UUID, which is what the broker assigns (`randomUUID()`, 122
 * random bits) when JSON-RPC `SendMessage` creates a task. Caller-chosen ids
 * (REST `POST /tasks`) and time-based UUID versions are not guess-resistant,
 * so they are refused rather than exposed.
 */
export const MCP_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MCP_POLL_INTERVAL_MIN_MS = 250;
export const MCP_POLL_INTERVAL_MAX_MS = 30_000;
export const MCP_POLL_INTERVAL_DEFAULT_MS = 2_000;
/** G3: poll interval while a task waits on an operator decision (the clamp cap). */
export const MCP_OPERATOR_WAIT_POLL_INTERVAL_MS = MCP_POLL_INTERVAL_MAX_MS;
export const MCP_STATUS_MESSAGE_MAX_LENGTH = 160;
export const MCP_CLARIFICATION_MAX_LENGTH = 4_000;

/** G2: every clarification `inputRequests` key starts with this prefix. */
export const MCP_CLARIFICATION_KEY_PREFIX = "clarification:";

/** The broker's own checkpoint id charset (`recordBrokerTaskCheckpoint`); it has no `@`. */
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Why a task is waiting.
 *
 * - `clarification`: the worker asked the requester to resolve ambiguous
 *   instructions (`ambiguous_scope`). A free-text answer is the input, so the
 *   MCP status is `input_required`.
 * - `operator_decision`: an approval-gated (`blocked`) task, or a checkpoint
 *   whose decision belongs to an operator (`approval_required`,
 *   `safety_gate`, `conflict_detected`, or no decision type — the broker
 *   defaults that to `approval_required`). G3: shown as `working` with no
 *   `inputRequests`, because nothing over MCP can answer it; see
 *   {@link evaluateMcpTaskInputResponse}.
 */
export type McpWaitKind = "clarification" | "operator_decision";

/** G1: closed-vocabulary reason carried by an `isError: true` tool result. */
export type McpToolErrorReason = "broker:failed" | "approval:rejected";
export type McpToolOutcome = { isError: false } | { isError: true; reason: McpToolErrorReason };

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  /** Closed-vocabulary tokens only (broker status, checkpoint state, decision type, approval); never task text. */
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  /** The broker does not expire tasks on a TTL. */
  ttlMs: null;
  pollIntervalMs: number;
  /** Facade annotation, not a wire field: present while the task waits on a clarification or an operator. */
  waitKind?: McpWaitKind;
  /** Facade annotation, not a wire field: present only when `status === "completed"`. */
  toolOutcome?: McpToolOutcome;
}

export class McpTaskIdError extends Error {
  constructor(reason: string) {
    super(`broker task id is not a valid MCP taskId: ${reason}`);
    this.name = "McpTaskIdError";
  }
}

/** G4: only a lowercase version-4 UUID (see {@link MCP_TASK_ID_PATTERN}). */
export function isValidMcpTaskId(id: unknown): id is string {
  return typeof id === "string" && MCP_TASK_ID_PATTERN.test(id);
}

/** Rejects (never rewrites) a broker id the facade may not expose, so the id stays a lossless reference. */
export function assertValidMcpTaskId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new McpTaskIdError("empty");
  if (!MCP_TASK_ID_PATTERN.test(id)) throw new McpTaskIdError("not a broker-assigned lowercase version-4 UUID");
  return id;
}

export function clampPollIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MCP_POLL_INTERVAL_DEFAULT_MS;
  return Math.min(MCP_POLL_INTERVAL_MAX_MS, Math.max(MCP_POLL_INTERVAL_MIN_MS, Math.round(value)));
}

type TaskStateFields = Pick<TaskRecord, "status" | "approvalOutcome" | "checkpoint">;

/**
 * G2: the `inputRequests` key for a clarification checkpoint, or `undefined`
 * if the checkpoint cannot be keyed safely (fails closed to an operator wait).
 *
 * The extension requires a key to be unique over the task's lifetime. A
 * worker may choose its own checkpoint id and could reuse one, so the key
 * binds both the id and the checkpoint's `recordedAt`. A resolved checkpoint
 * retires its key; a later checkpoint is recorded later and gets a new key.
 */
export function mcpClarificationKey(checkpoint: TaskRecord["checkpoint"]): string | undefined {
  if (!checkpoint || !CHECKPOINT_ID_PATTERN.test(checkpoint.checkpointId)) return undefined;
  if (typeof checkpoint.recordedAt !== "string" || !Number.isFinite(Date.parse(checkpoint.recordedAt))) return undefined;
  return `${MCP_CLARIFICATION_KEY_PREFIX}${checkpoint.checkpointId}@${checkpoint.recordedAt}`;
}

/**
 * Why the task is waiting, or `undefined` when it is not. Same
 * classification the broker enforces when a checkpoint is resumed (#2595,
 * `isOperatorDecisionCheckpoint`): only `ambiguous_scope` is a clarification,
 * so the facade never offers input the broker would refuse.
 */
export function mcpWaitKindForTask(task: TaskStateFields): McpWaitKind | undefined {
  switch (mapTaskState(task)) {
    case "auth-required":
      return "operator_decision";
    case "input-required":
      if (isOperatorDecisionCheckpoint(task.checkpoint)) return "operator_decision";
      return mcpClarificationKey(task.checkpoint) ? "clarification" : "operator_decision";
    default:
      return undefined;
  }
}

/** Exhaustive broker → MCP status mapping; a new A2A state fails to compile here. */
export function mcpTaskStatusForTask(task: TaskStateFields): McpTaskStatus {
  const state = mapTaskState(task);
  switch (state) {
    case "submitted":
    case "working":
      return "working";
    case "auth-required":
      // G3: an approval-gated task waits on an operator, out of band.
      return "working";
    case "input-required":
      return mcpWaitKindForTask(task) === "clarification" ? "input_required" : "working";
    case "completed":
    case "failed":
    case "rejected":
      // G1: the task ran to an end; failure is carried by toolOutcome.isError.
      return "completed";
    case "canceled":
      return "cancelled";
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled A2A task state: ${String(unhandled)}`);
    }
  }
}

/** G1: the tool-level outcome of a `completed` MCP task, or `undefined` for any other status. */
export function mcpToolOutcomeForTask(task: TaskStateFields): McpToolOutcome | undefined {
  switch (mapTaskState(task)) {
    case "completed":
      return { isError: false };
    case "failed":
      return { isError: true, reason: "broker:failed" };
    case "rejected":
      return { isError: true, reason: "approval:rejected" };
    default:
      return undefined;
  }
}

function statusMessageFor(task: TaskStateFields): string {
  const tokens = [`broker:${task.status}`];
  if (task.checkpoint) {
    tokens.push(`checkpoint:${task.checkpoint.state}`);
    if (task.checkpoint.decisionType) tokens.push(`decision:${task.checkpoint.decisionType}`);
  }
  if (task.approvalOutcome?.status) tokens.push(`approval:${task.approvalOutcome.status}`);
  else if (task.status === "blocked") tokens.push("approval:pending");
  return tokens.join(" ").slice(0, MCP_STATUS_MESSAGE_MAX_LENGTH);
}

export interface ProjectMcpTaskOptions {
  pollIntervalMs?: number;
}

/** Projects a broker task onto the MCP Task shape. Throws {@link McpTaskIdError} for an id the facade may not expose. */
export function projectMcpTask(
  task: TaskStateFields & Pick<TaskRecord, "id" | "createdAt" | "updatedAt">,
  options: ProjectMcpTaskOptions = {},
): McpTask {
  const status = mcpTaskStatusForTask(task);
  const waitKind = mcpWaitKindForTask(task);
  const projected: McpTask = {
    taskId: assertValidMcpTaskId(task.id),
    status,
    statusMessage: statusMessageFor(task),
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ttlMs: null,
    pollIntervalMs: waitKind === "operator_decision"
      ? MCP_OPERATOR_WAIT_POLL_INTERVAL_MS
      : clampPollIntervalMs(options.pollIntervalMs),
  };
  if (waitKind) projected.waitKind = waitKind;
  const toolOutcome = mcpToolOutcomeForTask(task);
  if (toolOutcome) projected.toolOutcome = toolOutcome;
  return projected;
}

/**
 * MCP `inputRequests`: one key for a clarification wait, `undefined`
 * otherwise. G3: an operator-decision wait has none, so nothing invites the
 * client (in an unattended session, the model) to answer it.
 */
export function mcpInputRequestsForTask(
  task: TaskStateFields,
): Record<string, { method: "elicitation/create"; params: { message: string; mode: "form" } }> | undefined {
  if (mcpWaitKindForTask(task) !== "clarification") return undefined;
  const key = mcpClarificationKey(task.checkpoint);
  if (!key) return undefined;
  return {
    [key]: {
      method: "elicitation/create",
      params: { message: "The worker needs clarification of the task instructions.", mode: "form" },
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
  | { accepted: true; kind: "clarification"; key: string; text: string }
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
 * G3: the server acknowledges such an update with an empty result, ignores
 * it, and logs the reason code.
 *
 * Only `clarification` accepts input: exactly the one outstanding key
 * (G2 — a key from an earlier checkpoint is `unexpected_keys`), an
 * elicitation result with `action: "accept"` and a non-empty `content.text`
 * of at most {@link MCP_CLARIFICATION_MAX_LENGTH} characters.
 */
export function evaluateMcpTaskInputResponse(task: TaskStateFields, inputResponses: unknown): McpInputEvaluation {
  const kind = mcpWaitKindForTask(task);
  if (!kind) return { accepted: false, reason: "not_input_required" };
  if (kind === "operator_decision") return { accepted: false, reason: "operator_decision_out_of_band" };

  const key = mcpClarificationKey(task.checkpoint);
  if (!key) return { accepted: false, reason: "operator_decision_out_of_band" };
  if (!isRecord(inputResponses)) return { accepted: false, reason: "missing_response" };
  const keys = Object.keys(inputResponses);
  if (keys.some((name) => name !== key)) return { accepted: false, reason: "unexpected_keys" };
  const response = inputResponses[key];
  if (!isRecord(response)) return { accepted: false, reason: "missing_response" };
  if (response.action !== "accept") return { accepted: false, reason: "declined" };
  const content = response.content;
  const text = isRecord(content) && typeof content.text === "string" ? content.text.trim() : "";
  if (!text || text.length > MCP_CLARIFICATION_MAX_LENGTH) return { accepted: false, reason: "invalid_clarification" };
  return { accepted: true, kind: "clarification", key, text };
}

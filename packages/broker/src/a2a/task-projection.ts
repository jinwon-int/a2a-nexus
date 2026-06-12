import type { TaskRecord, TaskStatus } from "../core/types.js";

export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export interface A2ATextPart {
  text: string;
}

export interface A2AMessage {
  role: "agent";
  parts: A2ATextPart[];
}

export interface A2ATaskStatusProjection {
  state: A2ATaskState;
  timestamp: string;
  message?: A2AMessage;
}

export interface A2ATaskProjection {
  id: string;
  kind: "task";
  status: A2ATaskStatusProjection;
  metadata: Record<string, unknown>;
  artifacts: Array<{ id: string }>;
}

export interface A2ATaskListProjection extends A2ATaskProjection {
  metadata: Omit<A2ATaskProjection["metadata"], "result"> & {
    resultSummary?: string;
  };
}

export function projectBrokerTask(task: TaskRecord): A2ATaskProjection {
  const summary = task.result?.summary ?? task.result?.note ?? task.message;
  return {
    id: task.id,
    kind: "task",
    status: {
      state: mapTaskState(task),
      timestamp: task.completedAt ?? task.updatedAt,
      message: summary
        ? {
            role: "agent",
            parts: [{ text: summary }],
          }
        : undefined,
    },
    metadata: {
      internalStatus: task.status,
      intent: task.intent,
      requester: task.requester,
      target: task.target,
      exchangeId: task.exchangeId,
      contextId: task.exchangeId,
      parentTaskId: task.parentTaskId,
      referenceTaskIds: task.referenceTaskIds,
      proposalId: task.proposalId,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      workspace: task.workspace,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancellation: task.cancellation,
      error: task.error,
      result: task.result,
      policyContext: task.policyContext,
      approval: task.approval,
      // Distributed-trace context (requester -> broker -> worker -> evidence),
      // present only when the request carried one.
      ...(task.via ? { via: task.via } : {}),
    },
    artifacts: (task.result?.artifactIds ?? task.artifactIds ?? []).map((id) => ({ id })),
  };
}

export function projectBrokerTaskForList(task: TaskRecord): A2ATaskListProjection {
  const projected = projectBrokerTask(task);
  const resultSummary = task.result?.summary ?? task.result?.note;
  return {
    ...projected,
    metadata: {
      internalStatus: task.status,
      intent: task.intent,
      requester: task.requester,
      target: task.target,
      exchangeId: task.exchangeId,
      contextId: task.exchangeId,
      parentTaskId: task.parentTaskId,
      referenceTaskIds: task.referenceTaskIds,
      proposalId: task.proposalId,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      workspace: task.workspace,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancellation: task.cancellation,
      error: task.error ? { code: task.error.code, message: task.error.message } : undefined,
      resultSummary,
      policyContext: task.policyContext,
      approval: task.approval,
      ...(task.via ? { via: task.via } : {}),
    },
  };
}

/**
 * Map a broker task to the public A2A 1.0 task state.
 *
 * Broker status → A2A 1.0 state:
 *
 * | Broker status | A2A 1.0 state    | Terminal? |
 * |--------------|------------------|----------|
 * | `blocked`    | `auth-required`  | no       |
 * | `queued`     | `submitted`      | no       |
 * | `claimed`    | `working`        | no       |
 * | `running`    | `working`        | no       |
 * | `succeeded`  | `completed`      | **yes**  |
 * | `failed`     | `failed`         | **yes**  |
 * | `canceled`   | `canceled` — or `rejected` when the task was terminated by an operator approval rejection (`approvalOutcome.status === "rejected"`) | **yes** |
 *
 * `blocked` means the task is approval-gated (`policyContext.requiresApproval`)
 * and waits for an out-of-band operator authorization decision — exactly the
 * A2A `auth-required` semantic. A rejection cancels the task tree with
 * `approvalOutcome.status: "rejected"`, which projects as the spec's
 * `rejected` terminal state instead of a generic `canceled`.
 *
 * `input-required` has no broker-internal source yet; it is included in
 * {@link A2ATaskState} for spec-complete typing and reserved for a future
 * requester-input checkpoint flow.
 *
 * **Terminal immutability:** Once a task reaches a terminal broker status
 * (`succeeded`, `failed`, or `canceled`), the broker rejects further
 * lifecycle mutations (reassign, complete, fail, cancel). The projected
 * A2A state (`completed`, `failed`, `canceled`, `rejected`) is likewise
 * immutable.
 */
function mapTaskState(task: Pick<TaskRecord, "status" | "approvalOutcome">): A2ATaskState {
  switch (task.status) {
    case "blocked":
      return "auth-required";
    case "queued":
      return "submitted";
    case "claimed":
    case "running":
      return "working";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return task.approvalOutcome?.status === "rejected" ? "rejected" : "canceled";
    default:
      throw new Error("unhandled task status");
  }
}

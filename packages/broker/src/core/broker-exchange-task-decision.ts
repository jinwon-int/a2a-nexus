import type {
  A2AExchangeMessageRecord,
  A2AExchangeState,
  CreateTaskRequest,
  TaskReassignRequest,
  TaskRecord,
  WorkerRecord,
} from "./types.js";

export interface ApplyBrokerExchangeMessageDecisionContext {
  workers: Map<string, WorkerRecord>;
  tasks: Map<string, TaskRecord>;
  requireWorker(nodeId: string): WorkerRecord;
  reassignTask(taskId: string, request: TaskReassignRequest): TaskRecord;
  createTask(request: CreateTaskRequest): TaskRecord;
  cancelActiveExchangeTask(exchange: A2AExchangeState, reason: string): void;
}

export function applyBrokerExchangeMessageDecision(
  exchange: A2AExchangeState,
  message: A2AExchangeMessageRecord,
  hasExplicitAssignment: boolean,
  context: ApplyBrokerExchangeMessageDecisionContext,
): void {
  exchange.targetNodeId = message.targetNodeId ?? exchange.targetNodeId ?? exchange.target.id;
  exchange.assignedWorkerId = message.assignedWorkerId ?? exchange.assignedWorkerId;
  exchange.currentDecision = message.decision ?? exchange.currentDecision;

  const targetWorker = context.workers.get(exchange.targetNodeId);
  if (targetWorker) {
    exchange.target = {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    };
  }

  if (!message.decision) {
    // message.targetNodeId is always populated (it defaults to the exchange
    // target), so gating on it made every decision-less thread message spawn a
    // task and flip a running exchange back to "queued". Only (re)assign when
    // the request carried an explicit routing target.
    if (hasExplicitAssignment) {
      const assignedWorkerId = exchange.assignedWorkerId ?? exchange.targetNodeId;
      ensureBrokerExchangeTask(exchange, message, assignedWorkerId, context);
      exchange.status = "queued";
    }
    return;
  }

  if (message.decision === "accepted" || message.decision === "partially_accepted") {
    const assignedWorkerId = exchange.assignedWorkerId ?? exchange.targetNodeId;
    exchange.assignedWorkerId = assignedWorkerId;
    exchange.status = "running";
    ensureBrokerExchangeTask(exchange, message, assignedWorkerId, context);
    return;
  }

  if (message.decision === "needs_clarification") {
    exchange.status = "queued";
    context.cancelActiveExchangeTask(exchange, `decision=${message.decision}`);
    return;
  }

  // Cancel the in-flight task first, then mark the exchange failed. The previous
  // code set "failed" before cancellation (a dead write that canceling the task
  // immediately overwrote) and only re-applied it afterward. addExchangeMessage
  // persists this final "failed" status.
  context.cancelActiveExchangeTask(exchange, `decision=${message.decision}`);
  exchange.status = "failed";
}

function ensureBrokerExchangeTask(
  exchange: A2AExchangeState,
  message: A2AExchangeMessageRecord,
  assignedWorkerId: string,
  context: ApplyBrokerExchangeMessageDecisionContext,
): void {
  const current = exchange.activeTaskId ? context.tasks.get(exchange.activeTaskId) ?? null : null;
  const assignedWorker = context.requireWorker(assignedWorkerId);
  const targetWorker = context.requireWorker(exchange.targetNodeId);

  if (current && current.status !== "succeeded" && current.status !== "failed" && current.status !== "canceled") {
    if (
      current.targetNodeId !== exchange.targetNodeId ||
      current.assignedWorkerId !== assignedWorkerId
    ) {
      context.reassignTask(current.id, {
        actor: message.actor ?? { id: "broker", role: "hub", kind: "service" },
        targetNodeId: exchange.targetNodeId,
        assignedWorkerId,
        note: `exchange ${exchange.id} synchronized from thread message ${message.id}`,
      });
    }
    exchange.status = "running";
    return;
  }

  const task = context.createTask({
    exchangeId: exchange.id,
    intent: exchange.intent,
    requester: exchange.requester,
    target: {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    },
    assignedWorkerId: assignedWorker.nodeId,
    message: message.message,
    via: message.via,
  });
  exchange.activeTaskId = task.id;
  exchange.assignedWorkerId = assignedWorker.nodeId;
  exchange.targetNodeId = targetWorker.nodeId;
  exchange.target = {
    id: targetWorker.nodeId,
    kind: "node",
    role: targetWorker.role,
  };
}

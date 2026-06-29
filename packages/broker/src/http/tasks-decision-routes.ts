// Task decision write routes — the actor/operator-gated task mutations that do
// NOT require worker HTTP-signature verification: POST
// /tasks/:id/{resume,approve,reject-approval,cancel,reassign}. Extracted from the
// server request closure into explicit-context handlers (continuing the #645
// dispatcher migration). The worker-signed lifecycle actions (claim/start/...)
// live separately because they need the server's signature-route closures.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import {
  assertRequesterCanSubscribeToTask,
  assertRequesterHasRole,
  assertRequesterMatchesParty,
  type RequesterIdentity,
} from "../core/request-security.js";
import type {
  A2APartyRole,
  TaskApprovalRequest,
  TaskApprovalTerminalRequest,
  TaskCancelRequest,
  TaskRecord,
  TaskReassignRequest,
} from "../core/types.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface TasksDecisionRouteContext {
  method: string | undefined;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

type TaskScopedContext = TasksDecisionRouteContext & { taskId: string };

interface TaskActorRequest {
  actor?: { id?: string; role?: A2APartyRole };
}

/** Read an actor-gated body, enforce the party (and optionally hub/operator) check. */
async function readActorGatedBody<T extends TaskActorRequest>(
  ctx: TaskScopedContext,
  scope: string,
  requireHubOperator: boolean,
): Promise<T> {
  const body = await readJson<T>(ctx.req);
  if (!body?.actor?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: body.actor.id, role: body.actor.role },
      scope,
    );
    if (requireHubOperator) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], scope);
    }
  }
  return body;
}

function sendTask(ctx: TaskScopedContext, task: TaskRecord): void {
  sendJson(ctx.res, 200, task);
}

/** POST /tasks/:id/resume — clear an operator checkpoint and resume the task. */
export async function handleResumeTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const body = await readJson<{ actorId?: string; checkpointId?: string }>(ctx.req);
  const actorId = body?.actorId ?? ctx.requesterIdentity?.id;
  if (!actorId) {
    throw new BrokerError("bad_request", "actorId is required");
  }
  const resumeTarget = ctx.broker.getTask(ctx.taskId);
  if (!resumeTarget) {
    throw new BrokerError("not_found", "task not found");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(ctx.requesterIdentity, { id: actorId }, "task.resume");
    // Clearing an operator checkpoint is a task mutation: the caller must be a
    // party to the task (requester / target / assigned worker) or a hub/operator.
    // Without this, anyone who knows a task id could clear another task's
    // awaiting_operator checkpoint.
    assertRequesterCanSubscribeToTask(ctx.requesterIdentity, resumeTarget);
  }
  const task = ctx.broker.resumeTask(ctx.taskId, actorId, { checkpointId: body?.checkpointId });
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/approve — approve a blocked task (hub/operator). */
export async function handleApproveTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const body = await readActorGatedBody<TaskApprovalRequest>(ctx, "task.approve", true);
  const task = ctx.broker.approveTask(ctx.taskId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/reject-approval — reject a blocked task's approval (hub/operator). */
export async function handleRejectTaskApprovalRequest(ctx: TaskScopedContext): Promise<void> {
  const body = await readActorGatedBody<TaskApprovalTerminalRequest>(ctx, "task.reject-approval", true);
  const task = ctx.broker.rejectTaskApproval(ctx.taskId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/cancel — cancel a task (party-gated, no hub/operator requirement). */
export async function handleCancelTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const body = await readActorGatedBody<TaskCancelRequest>(ctx, "task.cancel", false);
  const task = ctx.broker.cancelTask(ctx.taskId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/reassign — reassign a task to another worker (hub/operator). */
export async function handleReassignTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const body = await readActorGatedBody<TaskReassignRequest>(ctx, "task.reassign", true);
  const task = ctx.broker.reassignTask(ctx.taskId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** Route dispatcher for the actor/operator-gated task decision routes. */
export async function handleTasksDecisionRouteIfMatched(
  ctx: TasksDecisionRouteContext,
): Promise<boolean> {
  if (ctx.method !== "POST") {
    return false;
  }
  if (!(ctx.segments[0] === "tasks" && ctx.segments[1])) {
    return false;
  }
  const scoped: TaskScopedContext = { ...ctx, taskId: ctx.segments[1] };
  switch (ctx.segments[2]) {
    case "resume":
      await handleResumeTaskRequest(scoped);
      return true;
    case "approve":
      await handleApproveTaskRequest(scoped);
      return true;
    case "reject-approval":
      await handleRejectTaskApprovalRequest(scoped);
      return true;
    case "cancel":
      await handleCancelTaskRequest(scoped);
      return true;
    case "reassign":
      await handleReassignTaskRequest(scoped);
      return true;
    default:
      return false;
  }
}

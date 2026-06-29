// Task wake routes (POST /tasks/:id/wake/plan, POST /tasks/:id/wake/decision),
// extracted from the server request closure into explicit-context handlers
// (continuing the #645 dispatcher migration). Both are hub/operator-gated
// mutations that wait on the durable-persistence ack before responding.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import type { TaskWakeDecisionRequest, TaskWakePlanRequest } from "../core/types.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface TasksWakeRouteContext {
  method: string | undefined;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/** POST /tasks/:id/wake/plan — plan a wake for an accepted task; 201 (200 on replay). */
export async function handleTaskWakePlanRequest(
  ctx: TasksWakeRouteContext & { taskId: string },
): Promise<void> {
  const body = await readJson<TaskWakePlanRequest>(ctx.req);
  if (!body?.targetSessionKey) {
    throw new BrokerError("bad_request", "targetSessionKey is required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task.wake.plan");
  }
  const result = ctx.broker.planAcceptedTaskWake(ctx.taskId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, result.replayed ? 200 : 201, result);
}

/** POST /tasks/:id/wake/decision — record a wake decision for a task. */
export async function handleTaskWakeDecisionRequest(
  ctx: TasksWakeRouteContext & { taskId: string },
): Promise<void> {
  const body = await readJson<TaskWakeDecisionRequest>(ctx.req);
  if (!body?.status) {
    throw new BrokerError("bad_request", "status is required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task.wake.decision");
  }
  const task = ctx.broker.recordTaskWakeDecision(ctx.taskId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 200, task);
}

/** Route dispatcher for task wake routes. Returns true only when handled. */
export async function handleTasksWakeRouteIfMatched(ctx: TasksWakeRouteContext): Promise<boolean> {
  if (ctx.method !== "POST") {
    return false;
  }
  const { segments } = ctx;
  if (segments[0] === "tasks" && segments[1] && segments[2] === "wake" && segments.length === 4) {
    if (segments[3] === "plan") {
      await handleTaskWakePlanRequest({ ...ctx, taskId: segments[1] });
      return true;
    }
    if (segments[3] === "decision") {
      await handleTaskWakeDecisionRequest({ ...ctx, taskId: segments[1] });
      return true;
    }
  }
  return false;
}

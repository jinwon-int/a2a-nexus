import type { IncomingMessage, ServerResponse } from "node:http";

import {
  BrokerError,
  InMemoryA2ABroker,
} from "../core/broker.js";
import {
  assertRequesterCanSubscribeToTask,
  type A2AWorkerRouteScope,
  type RequesterIdentity,
} from "../core/request-security.js";
import type { A2AHttpSignatureVerifiedWorker } from "../server.js";
import { assertRequesterCanSubscribeToWorkerAssignments } from "../request-parsers.js";
import {
  handleTaskEventStream,
  handleWorkerAssignmentEventStream,
} from "./task-event-streams.js";

export interface A2ATaskStreamRouteContext {
  method: string | undefined;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
  taskSubscribeHeartbeatSec: number;
  assertWorkerHttpSignatureRoute: (
    req: IncomingMessage,
    url: URL,
  ) => Promise<A2AHttpSignatureVerifiedWorker | null>;
  assertVerifiedWorkerMatches: (
    verified: A2AHttpSignatureVerifiedWorker | null,
    expectedWorkerId: string | undefined,
    operation: A2AWorkerRouteScope,
  ) => void;
}

/** GET /a2a/workers/:workerId/assignment-events — worker assignment SSE stream. */
export async function handleA2AWorkerAssignmentEventsRoute(
  ctx: A2ATaskStreamRouteContext,
): Promise<void> {
  const workerId = ctx.segments[2];
  const verifiedWorker = await ctx.assertWorkerHttpSignatureRoute(ctx.req, ctx.url);
  ctx.assertVerifiedWorkerMatches(verifiedWorker, workerId, "workers.assignment-events");
  if (ctx.enforceRequesterIdentity) {
    assertRequesterCanSubscribeToWorkerAssignments(ctx.requesterIdentity, workerId);
  }
  if (!ctx.broker.getWorker(workerId)) {
    throw new BrokerError("not_found", "worker not found");
  }

  handleWorkerAssignmentEventStream(ctx.req, ctx.res, {
    broker: ctx.broker,
    workerId,
    heartbeatMs: ctx.taskSubscribeHeartbeatSec * 1000,
  });
}

/** GET /a2a/tasks/:taskId/events — per-task SSE stream. */
export function handleA2ATaskEventsRoute(ctx: A2ATaskStreamRouteContext): void {
  const taskId = ctx.segments[2];
  const task = ctx.broker.getTask(taskId);
  if (!task) {
    throw new BrokerError("not_found", "task not found");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterCanSubscribeToTask(ctx.requesterIdentity, task);
  }

  handleTaskEventStream(ctx.req, ctx.res, {
    broker: ctx.broker,
    task,
    heartbeatMs: ctx.taskSubscribeHeartbeatSec * 1000,
  });
}

/** Route dispatcher for dynamic A2A task/worker SSE stream routes. */
export async function handleA2ATaskStreamRouteIfMatched(
  ctx: A2ATaskStreamRouteContext,
): Promise<boolean> {
  if (ctx.method !== "GET") {
    return false;
  }

  if (
    ctx.segments[0] === "a2a" &&
    ctx.segments[1] === "workers" &&
    ctx.segments[2] &&
    ctx.segments[3] === "assignment-events" &&
    ctx.segments.length === 4
  ) {
    await handleA2AWorkerAssignmentEventsRoute(ctx);
    return true;
  }

  if (
    ctx.segments[0] === "a2a" &&
    ctx.segments[1] === "tasks" &&
    ctx.segments[2] &&
    ctx.segments[3] === "events" &&
    ctx.segments.length === 4
  ) {
    handleA2ATaskEventsRoute(ctx);
    return true;
  }

  return false;
}

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
  A2A_VERSION_HEADER,
  SUPPORTED_A2A_VERSIONS,
  negotiateA2AVersion,
} from "../a2a/version-negotiation.js";
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

  // A2A-Version negotiation on the SSE surface, mirroring the JSON-RPC route:
  // an explicit unsupported version is rejected fail-closed; a negotiated
  // client gets v1.0 ProtoJSON task payloads (TASK_STATE_*), header-less
  // clients keep the historical lowercase projection (#1912 D1).
  const negotiated = negotiateA2AVersion(ctx.req.headers[A2A_VERSION_HEADER]);
  if (!negotiated.ok) {
    throw new BrokerError("bad_request", negotiated.message, {
      requested: negotiated.requested,
      supported: [...SUPPORTED_A2A_VERSIONS],
    });
  }
  ctx.res.setHeader("a2a-version", negotiated.version);

  handleTaskEventStream(ctx.req, ctx.res, {
    broker: ctx.broker,
    task,
    heartbeatMs: ctx.taskSubscribeHeartbeatSec * 1000,
    responseShape: negotiated.requested !== null ? "spec" : "legacy",
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

// Tasks collection routes (GET /tasks, POST /tasks, POST /tasks/requeue_stale),
// extracted from the server request closure into explicit-context handlers
// (continuing the #645 dispatcher migration). GET /tasks worker-filtered queries
// verify the A2A HTTP worker signature, so the context carries the server's two
// signature-route closures; create and requeue are mutations.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import {
  assertRequesterHasRole,
  assertRequesterMatchesParty,
  type A2AWorkerRouteScope,
  type RequesterIdentity,
} from "../core/request-security.js";
import type { CreateTaskRequest, TaskRecord } from "../core/types.js";
import type { A2AHttpSignatureVerifiedWorker } from "../server.js";
import { assertCreateTaskRequestParties, optionalString } from "../request-parsers.js";
import {
  assertCreateTaskPayloadWithinLimit,
  listTaskItemsForReadPath,
  listTasksForReadPath,
} from "../task-read-paths.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { DEFAULT_TASK_LIST_LIMIT, numberQueryParam, taskFiltersFromUrl } from "./read-path-filters.js";
import { sendJson } from "./response.js";
import { parseTaskAcceptance } from "../worker-acceptance.js";
import { LIVE_TASK_MODE, admitLiveTaskSubmission } from "../core/live-task-admission.js";

export interface TasksCollectionRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
  maxTaskPayloadBytes: number;
  workerOfflineAfterSec: number;
  liveApprovalSigningKey: string;
  brokerId: string;
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

/** GET /tasks — list tasks (item or full detail); worker-filtered queries are signature-gated. */
export async function handleTasksListRequest(ctx: TasksCollectionRouteContext): Promise<void> {
  const { url } = ctx;
  if (url.searchParams.has("worker") || url.searchParams.has("assignedWorkerId")) {
    const workerParam = optionalString(url.searchParams.get("worker"));
    const assignedWorkerParam = optionalString(url.searchParams.get("assignedWorkerId"));
    if (workerParam && assignedWorkerParam && workerParam !== assignedWorkerParam) {
      throw new BrokerError("bad_request", "worker and assignedWorkerId query parameters must match when both are provided");
    }
    const expectedWorkerId = assignedWorkerParam ?? workerParam;
    if (!expectedWorkerId) {
      throw new BrokerError("bad_request", "worker or assignedWorkerId query parameter is required");
    }
    const verifiedWorker = await ctx.assertWorkerHttpSignatureRoute(ctx.req, url);
    ctx.assertVerifiedWorkerMatches(verifiedWorker, expectedWorkerId, "tasks.list");
  }
  const filters = taskFiltersFromUrl(url, { defaultLimit: DEFAULT_TASK_LIST_LIMIT });
  const includeFullTaskRecords = url.searchParams.get("detail") === "full" || url.searchParams.get("include") === "full";
  if (includeFullTaskRecords) {
    const tasks = listTasksForReadPath(ctx.stateStore, ctx.broker, filters);
    sendJson(ctx.res, 200, {
      count: tasks.length,
      limit: filters.limit,
      items: tasks,
    });
    return;
  }
  const items = listTaskItemsForReadPath(ctx.stateStore, ctx.broker, filters);
  sendJson(ctx.res, 200, {
    count: items.length,
    limit: filters.limit,
    items,
  });
}

function assertTaskAcceptanceShapeAtCreate(body: CreateTaskRequest): void {
  const parsed = parseTaskAcceptance({ payload: body.payload } as TaskRecord);
  if (!parsed || !parsed.error) return;
  const reason = typeof parsed.error.details?.reason === "string"
    ? parsed.error.details.reason
    : parsed.error.message;
  throw new BrokerError("acceptance_malformed", parsed.error.message, { reason });
}

/** POST /tasks — create a task; 202 (with the created task) on a persistence-ack timeout. */
export async function handleCreateTaskRequest(ctx: TasksCollectionRouteContext): Promise<void> {
  let body = await readJson<CreateTaskRequest>(ctx.req);
  if (!body) {
    throw new BrokerError("bad_request", "request body is required");
  }
  assertCreateTaskRequestParties(body);
  assertTaskAcceptanceShapeAtCreate(body);
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: body.requester.id, role: body.requester.role },
      "task.create",
    );
  }
  assertCreateTaskPayloadWithinLimit(body, ctx.maxTaskPayloadBytes);
  if (body.payload?.mode === LIVE_TASK_MODE) {
    if (body.id && ctx.broker.getTask(body.id)) {
      throw new BrokerError("invalid_transition", `task ${body.id} already exists`);
    }
    const worker = ctx.broker.getWorkerView(body.target.id, ctx.workerOfflineAfterSec * 1000);
    body = admitLiveTaskSubmission(body, {
      requesterIdentity: ctx.requesterIdentity,
      worker,
      stateStore: ctx.stateStore,
      signingKey: ctx.liveApprovalSigningKey,
      brokerId: ctx.brokerId,
    });
  }
  const task = ctx.broker.createTask(body);
  // Durable-ack disambiguation (a2a-nexus#636/#638): at this point the task
  // EXISTS in the broker — a persistence-queue ack timeout must not be reported
  // as a creation failure with no task id, or the operator cannot tell rejected
  // from accepted-but-slow. 202 carries the created task plus the ack error so
  // dispatch tooling can classify it as accepted-unconfirmed and verify via
  // GET /tasks/:id.
  try {
    await awaitDurablePersistenceAck(ctx.stateStore);
  } catch (error) {
    if (
      error instanceof BrokerError &&
      (error.code === "queue_drain_timeout" || error.code === "queue_saturated")
    ) {
      sendJson(ctx.res, 202, {
        task,
        durable: false,
        ackError: { code: error.code, message: error.message },
        hint: `task ${task.id} was created; confirm with GET /tasks/${task.id} — it persists on the next successful flush`,
      });
      return;
    }
    throw error;
  }
  sendJson(ctx.res, 201, task);
}

/** POST /tasks/requeue_stale — operator-triggered stale-task requeue sweep. */
export async function handleRequeueStaleTasksRequest(ctx: TasksCollectionRouteContext): Promise<void> {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task.requeue_stale");
  }
  const olderThanSec = numberQueryParam(ctx.url, "older_than_seconds") ?? 300;
  const { requeued, deadLettered } = ctx.broker.requeueStaleTasksDetailed(olderThanSec * 1000, {
    workerOfflineAfterMs: ctx.workerOfflineAfterSec * 1000,
  });
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 200, {
    ok: true,
    olderThanSeconds: olderThanSec,
    workerOfflineAfterSeconds: ctx.workerOfflineAfterSec,
    maxRequeueAttempts: ctx.broker.getMaxRequeueAttempts(),
    policy: "requeue_only",
    requeued: requeued.length,
    deadLettered: deadLettered.length,
    items: requeued.map((task) => ({
      id: task.id,
      status: task.status,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      proposalId: task.proposalId,
      requeueCount: task.requeueCount,
      updatedAt: task.updatedAt,
    })),
    deadLetteredItems: deadLettered.map((task) => ({
      id: task.id,
      status: task.status,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      proposalId: task.proposalId,
      requeueCount: task.requeueCount,
      error: task.error,
      updatedAt: task.updatedAt,
    })),
  });
}

/** Route dispatcher for tasks collection routes. Returns true only when handled. */
export async function handleTasksCollectionRouteIfMatched(
  ctx: TasksCollectionRouteContext,
): Promise<boolean> {
  if (ctx.method === "GET" && ctx.path === "/tasks") {
    await handleTasksListRequest(ctx);
    return true;
  }
  if (ctx.method === "POST" && ctx.path === "/tasks") {
    await handleCreateTaskRequest(ctx);
    return true;
  }
  if (ctx.method === "POST" && ctx.path === "/tasks/requeue_stale") {
    await handleRequeueStaleTasksRequest(ctx);
    return true;
  }
  return false;
}

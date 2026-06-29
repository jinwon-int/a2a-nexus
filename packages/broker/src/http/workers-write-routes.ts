// Worker write routes (POST /workers/register, POST /workers/:id/heartbeat),
// extracted from the server request closure into explicit-context handlers
// (continuing the #645 dispatcher migration; the GET read paths live in
// workers-read.ts). Both verify the request's A2A HTTP worker signature and
// identity-match the signed requester, so the route context carries the server's
// two signature-route closures, and both record per-phase register/heartbeat
// timing for /schedz diagnostics.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import {
  assertRequesterMatchesParty,
  type A2AWorkerRouteScope,
  type RequesterIdentity,
} from "../core/request-security.js";
import type { RegisterWorkerRequest, WorkerHeartbeatRequest } from "../core/types.js";
import type { A2AHttpSignatureVerifiedWorker } from "../server.js";
import { recordWorkerHeartbeatPhase, recordWorkerRegisterPhase } from "../worker-phase-timing.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";
import { toWorkerView } from "./workers-read.js";

export interface WorkersWriteRouteContext {
  method: string | undefined;
  path: string;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  brokerId: string | undefined;
  workerOfflineAfterMs: number;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
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

/** POST /workers/register — register (or refresh) a worker; returns its online view. */
export async function handleRegisterWorkerRequest(ctx: WorkersWriteRouteContext): Promise<void> {
  const verifiedWorker = await ctx.assertWorkerHttpSignatureRoute(ctx.req, ctx.url);
  const readJsonStartedAt = performance.now();
  const body = await readJson<RegisterWorkerRequest>(ctx.req);
  recordWorkerRegisterPhase("readJson", readJsonStartedAt);
  if (!body) {
    throw new BrokerError("bad_request", "request body is required");
  }
  const workerId = typeof body.nodeId === "string" ? body.nodeId : undefined;
  ctx.assertVerifiedWorkerMatches(verifiedWorker, workerId, "worker.register");
  if (ctx.enforceRequesterIdentity) {
    const authAssertStartedAt = performance.now();
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: body.nodeId, role: body.role },
      "worker.register",
    );
    recordWorkerRegisterPhase("authAssert", authAssertStartedAt, workerId);
  }
  const brokerRegisterStartedAt = performance.now();
  const worker = ctx.broker.registerWorker(body);
  recordWorkerRegisterPhase("brokerRegister", brokerRegisterStartedAt, workerId);
  // Registration is always online — use toWorkerView for consistent fields
  const toWorkerViewStartedAt = performance.now();
  const workerView = toWorkerView(worker, ctx.workerOfflineAfterMs);
  recordWorkerRegisterPhase("toWorkerView", toWorkerViewStartedAt, workerId);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 201, { ...workerView, brokerId: ctx.brokerId });
}

/** POST /workers/:id/heartbeat — refresh a worker's liveness; returns its online view. */
export async function handleWorkerHeartbeatRequest(
  ctx: WorkersWriteRouteContext & { workerId: string },
): Promise<void> {
  const verifiedWorker = await ctx.assertWorkerHttpSignatureRoute(ctx.req, ctx.url);
  const { workerId } = ctx;
  ctx.assertVerifiedWorkerMatches(verifiedWorker, workerId, "worker.heartbeat");
  const readJsonStartedAt = performance.now();
  const body = await readJson<WorkerHeartbeatRequest>(ctx.req);
  recordWorkerHeartbeatPhase("readJson", readJsonStartedAt, workerId);
  if (ctx.enforceRequesterIdentity) {
    const authLookupStartedAt = performance.now();
    const existingWorker = ctx.broker.getWorkerCachedFirst(workerId);
    recordWorkerHeartbeatPhase("authLookup", authLookupStartedAt, workerId);
    const authAssertStartedAt = performance.now();
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: workerId, role: existingWorker?.role },
      "worker.heartbeat",
    );
    recordWorkerHeartbeatPhase("authAssert", authAssertStartedAt, workerId);
  }
  const heartbeatStartedAt = performance.now();
  const worker = ctx.broker.heartbeatWorker(workerId, body ?? undefined);
  recordWorkerHeartbeatPhase("brokerHeartbeat", heartbeatStartedAt, workerId);
  // Heartbeat always implies worker-plane online — use toWorkerView for consistent fields
  const toWorkerViewStartedAt = performance.now();
  const workerView = toWorkerView(worker, ctx.workerOfflineAfterMs);
  recordWorkerHeartbeatPhase("toWorkerView", toWorkerViewStartedAt, workerId);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 200, workerView);
}

/** Route dispatcher for worker write routes. Returns true only when handled. */
export async function handleWorkersWriteRouteIfMatched(
  ctx: WorkersWriteRouteContext,
): Promise<boolean> {
  if (ctx.method !== "POST") {
    return false;
  }
  if (ctx.path === "/workers/register") {
    await handleRegisterWorkerRequest(ctx);
    return true;
  }
  if (ctx.segments[0] === "workers" && ctx.segments[1] && ctx.segments[2] === "heartbeat") {
    await handleWorkerHeartbeatRequest({ ...ctx, workerId: ctx.segments[1] });
    return true;
  }
  return false;
}

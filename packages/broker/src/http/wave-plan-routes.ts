// Durable wave plan lifecycle routes (#1357 G3-c HTTP surface).
//
// POST   /wave-plans                  create a draft plan from a spec
// POST   /wave-plans/{id}/start       draft -> running
// POST   /wave-plans/{id}/evidence    report current-stage evidence + apply gate
// POST   /wave-plans/{id}/advance     stage_ready -> next stage / completed (PRIVILEGED)
// POST   /wave-plans/{id}/abort       any non-terminal -> aborted
// GET    /wave-plans                  list plans
// GET    /wave-plans/{id}             get one plan (status)
//
// `advance` is the load-bearing privileged step (docs/a2ad-round-dispatch.md:
// "stage_ready is a signal, not an action") — the next-stage dispatch is only
// ever taken by an explicit hub/operator advance call, never auto-taken. All
// mutations are hub/operator-scoped; reads are open to the broader observer set.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import { WavePlanError, type WaveStageEvidence } from "../core/wave-plan.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

const WAVE_PLAN_WRITE_ROLES = ["hub", "operator"] as const;
const WAVE_PLAN_READ_ROLES = ["hub", "operator", "analyst", "researcher", "live-trader"] as const;

export interface WavePlanRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/**
 * Translate a wave-plan state-machine error into the broker's HTTP error
 * taxonomy: a malformed spec is a 400, an illegal transition or unmet gate is a
 * 409 conflict with the plan's current state. Anything else re-throws.
 */
function rethrowAsBrokerError(error: unknown): never {
  if (error instanceof WavePlanError) {
    if (error.code === "wave_spec_invalid") {
      throw new BrokerError("bad_request", error.message);
    }
    throw new BrokerError("invalid_transition", error.message);
  }
  throw error;
}

function requireExistingPlan(ctx: WavePlanRouteContext, wavePlanId: string): void {
  if (!ctx.broker.getWavePlan(wavePlanId)) {
    throw new BrokerError("not_found", `wave plan '${wavePlanId}' not found`);
  }
}

function pickEvidence(body: Record<string, unknown> | null | undefined): WaveStageEvidence {
  const evidence: WaveStageEvidence = {};
  if (typeof body?.substantiveCount === "number") evidence.substantiveCount = body.substantiveCount;
  if (typeof body?.approvalGranted === "boolean") evidence.approvalGranted = body.approvalGranted;
  if (typeof body?.manualPass === "boolean") evidence.manualPass = body.manualPass;
  return evidence;
}

/** POST /wave-plans — create a draft plan from a spec. */
async function handleCreate(ctx: WavePlanRouteContext): Promise<void> {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, [...WAVE_PLAN_WRITE_ROLES], "wave-plan.create");
  }
  const body = await readJson<Record<string, unknown>>(ctx.req);
  if (typeof body?.wavePlanId === "string" && ctx.broker.getWavePlan(body.wavePlanId)) {
    throw new BrokerError("invalid_transition", `wave plan '${body.wavePlanId}' already exists`);
  }
  let plan;
  try {
    plan = ctx.broker.createWavePlan(body);
  } catch (error) {
    rethrowAsBrokerError(error);
  }
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 201, { plan }, { "cache-control": "no-store" });
}

/** POST /wave-plans/{id}/{action} — start | evidence | advance | abort. */
async function handleLifecycle(ctx: WavePlanRouteContext, wavePlanId: string, action: string): Promise<void> {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, [...WAVE_PLAN_WRITE_ROLES], `wave-plan.${action}`);
  }
  requireExistingPlan(ctx, wavePlanId);
  let plan;
  try {
    switch (action) {
      case "start":
        plan = ctx.broker.startWavePlan(wavePlanId);
        break;
      case "evidence": {
        const body = await readJson<Record<string, unknown>>(ctx.req);
        plan = ctx.broker.reportWaveStageEvidence(wavePlanId, pickEvidence(body));
        break;
      }
      case "advance":
        plan = ctx.broker.advanceWavePlan(wavePlanId);
        break;
      case "abort":
        plan = ctx.broker.abortWavePlan(wavePlanId);
        break;
      default:
        throw new BrokerError("not_found", `unknown wave-plan action '${action}'`);
    }
  } catch (error) {
    rethrowAsBrokerError(error);
  }
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 200, { plan }, { "cache-control": "no-store" });
}

/** GET /wave-plans — list plans. */
function handleList(ctx: WavePlanRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, [...WAVE_PLAN_READ_ROLES], "wave-plan.list");
  }
  const plans = ctx.broker.listWavePlans();
  sendJson(ctx.res, 200, { kind: "wave-plans", count: plans.length, plans }, { "cache-control": "no-store" });
}

/** GET /wave-plans/{id} — get one plan. */
function handleGet(ctx: WavePlanRouteContext, wavePlanId: string): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, [...WAVE_PLAN_READ_ROLES], "wave-plan.get");
  }
  const plan = ctx.broker.getWavePlan(wavePlanId);
  if (!plan) {
    throw new BrokerError("not_found", `wave plan '${wavePlanId}' not found`);
  }
  sendJson(ctx.res, 200, { plan }, { "cache-control": "no-store" });
}

/**
 * Route dispatcher for the durable wave plan lifecycle. Returns true only when
 * one of the wave-plan paths is handled.
 */
export async function handleWavePlanRoutesIfMatched(ctx: WavePlanRouteContext): Promise<boolean> {
  if (ctx.path !== "/wave-plans" && !ctx.path.startsWith("/wave-plans/")) {
    return false;
  }

  if (ctx.method === "POST" && ctx.path === "/wave-plans") {
    await handleCreate(ctx);
    return true;
  }
  if (ctx.method === "GET" && ctx.path === "/wave-plans") {
    handleList(ctx);
    return true;
  }

  // /wave-plans/{id} or /wave-plans/{id}/{action}
  const rest = ctx.path.slice("/wave-plans/".length);
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const wavePlanId = decodeURIComponent(segments[0] ?? "");
  if (!wavePlanId) {
    return false;
  }

  if (ctx.method === "GET" && segments.length === 1) {
    handleGet(ctx, wavePlanId);
    return true;
  }
  if (ctx.method === "POST" && segments.length === 2) {
    await handleLifecycle(ctx, wavePlanId, segments[1]);
    return true;
  }

  return false;
}

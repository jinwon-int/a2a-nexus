/**
 * Read-only HTTP routes for the WavePlanDagV2 rehearsal-evidence store
 * (#1800 slice 5).
 *
 * Exactly two GET endpoints under an independent `/wave-plan-dag-v2/*`
 * prefix — deliberately disjoint from v1's `/wave-plans*` so the versioned
 * dispatch boundary (#1994) stays structurally unambiguous: a request that
 * reaches this file is V2 by construction, and nothing here can touch the
 * v1 wave-plan lifecycle. Responses project only stored closed entries plus
 * mode/enablement diagnostics; there are no write routes (recording happens
 * through explicit broker calls only) and no free-form content — entries are
 * the same closed unions the store validates.
 *
 * Authorization mirrors the v1 wave-plan posture: edge-secret enforcement is
 * server-global, and requester-identity role checks apply when enabled.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker-error.js";
import type { InMemoryA2ABroker } from "../core/broker.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import { sendJson } from "./response.js";

const WAVE_PLAN_DAG_V2_PREFIX = "/wave-plan-dag-v2/";
/** Identical to v1 wave-plan read roles — same posture, independent prefix. */
const WAVE_PLAN_DAG_V2_READ_ROLES = ["hub", "operator", "analyst", "researcher", "live-trader"] as const;

interface WavePlanDagV2RouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

function assertReadRole(ctx: WavePlanDagV2RouteContext): void {
  if (!ctx.enforceRequesterIdentity || !ctx.requesterIdentity) return;
  assertRequesterHasRole(ctx.requesterIdentity, [...WAVE_PLAN_DAG_V2_READ_ROLES], "wave-plan-dag-v2.read");
}

/** GET /wave-plan-dag-v2/admissions — every admitted manifest on record. */
function handleAdmissions(ctx: WavePlanDagV2RouteContext): void {
  assertReadRole(ctx);
  const diagnostics = ctx.broker.wavePlanDagV2RecordDiagnostics();
  const admissions = ctx.broker.listWavePlanDagV2Admissions();
  sendJson(
    ctx.res,
    200,
    {
      kind: "wave-plan-dag-v2-admissions",
      mode: diagnostics.mode,
      count: admissions.length,
      admissions,
      diagnostics: {
        appends: diagnostics.appends,
        duplicates: diagnostics.duplicates,
        rejected: diagnostics.rejected,
        skipped: diagnostics.skipped,
        lastSkipReason: diagnostics.lastSkipReason,
      },
    },
    { "cache-control": "no-store" },
  );
}

/**
 * GET /wave-plan-dag-v2/rehearsals?manifestDigest=sha256:… — all preserved
 * rehearsal outcomes of one manifest. Unknown digests are an empty list, not
 * a 404: absence leaks nothing and the list answer stays total.
 */
function handleRehearsals(ctx: WavePlanDagV2RouteContext, url: URL): void {
  assertReadRole(ctx);
  const digest = url.searchParams.get("manifestDigest") ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new BrokerError("bad_request", "manifestDigest query parameter must be sha256:<64 lowercase hex>");
  }
  const diagnostics = ctx.broker.wavePlanDagV2RecordDiagnostics();
  const rehearsals = ctx.broker.listWavePlanDagV2Rehearsals(digest);
  sendJson(
    ctx.res,
    200,
    {
      kind: "wave-plan-dag-v2-rehearsals",
      mode: diagnostics.mode,
      manifestDigest: digest,
      count: rehearsals.length,
      rehearsals,
    },
    { "cache-control": "no-store" },
  );
}

export async function handleWavePlanDagV2RoutesIfMatched(
  ctx: {
    method: string | undefined;
    path: string;
    req: IncomingMessage;
    res: ServerResponse;
    broker: InMemoryA2ABroker;
    enforceRequesterIdentity: boolean;
    requesterIdentity: RequesterIdentity | null;
  },
  url: URL,
): Promise<boolean> {
  if (!ctx.path.startsWith(WAVE_PLAN_DAG_V2_PREFIX)) return false;

  if (ctx.method !== "GET") {
    throw new BrokerError("bad_request", `wave-plan-dag-v2 surface is read-only (${String(ctx.method)} not allowed)`);
  }

  const routeCtx: WavePlanDagV2RouteContext = {
    method: ctx.method,
    path: ctx.path,
    res: ctx.res,
    broker: ctx.broker,
    enforceRequesterIdentity: ctx.enforceRequesterIdentity,
    requesterIdentity: ctx.requesterIdentity,
  };

  if (ctx.path === "/wave-plan-dag-v2/admissions") {
    handleAdmissions(routeCtx);
    return true;
  }
  if (ctx.path === "/wave-plan-dag-v2/rehearsals") {
    handleRehearsals(routeCtx, url);
    return true;
  }
  return false;
}

/**
 * Read-only operator projection for bounded PR review lineages (#1518 Phase 3b).
 *
 * Mutations stay inside the broker API until a later phase wires a reviewed
 * record-mode event source. This surface never exposes the frozen contract,
 * raw receipts, diff hashes, or the full finding ledger.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import {
  assertRequesterHasRole,
  type RequesterIdentity,
} from "../core/request-security.js";
import { sendJson } from "./response.js";

const REVIEW_LINEAGE_READ_ROLES = [
  "hub",
  "operator",
  "analyst",
  "researcher",
] as const;

export interface ReviewLineageRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

function assertReadAccess(ctx: ReviewLineageRouteContext, action: string): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(
      ctx.requesterIdentity,
      [...REVIEW_LINEAGE_READ_ROLES],
      action,
    );
  }
}

export function handleReviewLineageRoutesIfMatched(
  ctx: ReviewLineageRouteContext,
): boolean {
  if (
    ctx.path !== "/review-lineages"
    && !ctx.path.startsWith("/review-lineages/")
  ) {
    return false;
  }
  if (ctx.method !== "GET") return false;

  if (ctx.path === "/review-lineages") {
    assertReadAccess(ctx, "review-lineage.list");
    const lineages = ctx.broker.listReviewLineages();
    sendJson(
      ctx.res,
      200,
      { kind: "review-lineages", count: lineages.length, lineages },
      { "cache-control": "no-store" },
    );
    return true;
  }

  const rest = ctx.path.slice("/review-lineages/".length);
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 1) return false;

  assertReadAccess(ctx, "review-lineage.get");
  const lineageId = decodeURIComponent(segments[0]);
  const lineage = ctx.broker.getReviewLineage(lineageId);
  if (!lineage) {
    throw new BrokerError(
      "not_found",
      `review lineage '${lineageId}' not found`,
    );
  }
  sendJson(
    ctx.res,
    200,
    { lineage },
    { "cache-control": "no-store" },
  );
  return true;
}

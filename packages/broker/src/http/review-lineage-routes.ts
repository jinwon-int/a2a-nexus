/**
 * Operator projection and explicit authenticated cancel source for bounded PR
 * review lineages (#1518 Phases 3b/14/15).
 *
 * This surface never exposes the frozen contract, raw receipts, diff hashes,
 * or the full finding ledger. Mutations are limited to operator-owned,
 * exact-field contract freeze and cancellation decisions; generic task
 * creation/cancellation is unrelated.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { ObservationValidationError } from "../review-lifecycle/observation.js";
import { SourceCarrierValidationError } from "../review-lifecycle/source-carrier.js";
import {
  assertRequesterHasRole,
  type RequesterIdentity,
} from "../core/request-security.js";
import { readJson } from "./body.js";
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

export async function handleReviewLineageRoutesIfMatched(
  ctx: ReviewLineageRouteContext,
): Promise<boolean> {
  if (
    ctx.path !== "/review-lineages"
    && !ctx.path.startsWith("/review-lineages/")
  ) {
    return false;
  }
  if (ctx.method === "GET" && ctx.path === "/review-lineages") {
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
  if (ctx.method === "POST" && ctx.path === "/review-lineages") {
    // The normative lifecycle contract permits only an operator to start a
    // fresh lineage. This gate is unconditional even for legacy/test configs
    // that relax requester enforcement on older routes.
    assertRequesterHasRole(
      ctx.requesterIdentity,
      ["operator"],
      "review-lineage.create",
    );
    const body = await readJson(ctx.req);
    if (!body) {
      throw new BrokerError("bad_request", "request body is required");
    }
    let result;
    try {
      result = await ctx.broker.recordOperatorReviewLineageCreate(
        body,
        ctx.requesterIdentity!.id,
      );
    } catch (error) {
      if (
        error instanceof SourceCarrierValidationError
        || error instanceof ObservationValidationError
      ) {
        throw new BrokerError("bad_request", error.message);
      }
      throw error;
    }
    if (!result) {
      throw new BrokerError(
        "invalid_transition",
        "review lineage recording is disabled",
      );
    }
    if (
      result.status === "missing_lineage"
      || result.status === "subject_conflict"
      || result.status === "transition_rejected"
      || result.status === "idempotency_conflict"
    ) {
      throw new BrokerError(
        "invalid_transition",
        `review lineage create rejected: ${result.status}`,
      );
    }
    sendJson(
      ctx.res,
      result.status === "replayed" ? 200 : 201,
      { result },
      { "cache-control": "no-store" },
    );
    return true;
  }

  const rest = ctx.path.slice("/review-lineages/".length);
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  if (
    ctx.method === "POST"
    && segments.length === 2
    && segments[1] === "operator-cancel"
  ) {
    // Unlike the broader read surface, the first authoritative source kind is
    // always identity-gated, including local/test configurations that relax
    // requester enforcement for legacy routes.
    assertRequesterHasRole(
      ctx.requesterIdentity,
      ["operator"],
      "review-lineage.operator-cancel",
    );
    const body = await readJson(ctx.req);
    if (!body) {
      throw new BrokerError("bad_request", "request body is required");
    }
    const lineageId = decodeURIComponent(segments[0]);
    let result;
    try {
      result = await ctx.broker.recordOperatorReviewLineageCancel(
        lineageId,
        body,
        ctx.requesterIdentity!.id,
      );
    } catch (error) {
      if (
        error instanceof SourceCarrierValidationError
        || error instanceof ObservationValidationError
      ) {
        throw new BrokerError("bad_request", error.message);
      }
      throw error;
    }
    if (!result) {
      throw new BrokerError(
        "invalid_transition",
        "review lineage recording is disabled",
      );
    }
    if (result.status === "missing_lineage") {
      throw new BrokerError("not_found", "review lineage not found");
    }
    if (
      result.status === "subject_conflict"
      || result.status === "transition_rejected"
      || result.status === "idempotency_conflict"
    ) {
      throw new BrokerError(
        "invalid_transition",
        `review lineage operator cancel rejected: ${result.status}`,
      );
    }
    sendJson(
      ctx.res,
      result.status === "replayed" ? 200 : 201,
      { result },
      { "cache-control": "no-store" },
    );
    return true;
  }

  if (ctx.method !== "GET" || segments.length !== 1) return false;

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

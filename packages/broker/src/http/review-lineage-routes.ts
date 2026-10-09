/**
 * Operator projection and explicit authenticated cancel source for bounded PR
 * review lineages (#1518 Phases 3b/14-18).
 *
 * This surface never exposes the frozen contract, raw receipts, diff hashes,
 * or the full finding ledger. Mutations are limited to operator-owned,
 * exact-field contract freeze/cancellation/correction-generation/reviewer-
 * replacement decisions and an explicitly worker-signed review report;
 * generic task creation, completion, fixer, and cancellation behavior is
 * unrelated.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { ObservationValidationError } from "../review-lifecycle/observation.js";
import { SourceCarrierValidationError } from "../review-lifecycle/source-carrier.js";
import {
  assertRequesterHasRole,
  type A2AWorkerRouteScope,
  type RequesterIdentity,
} from "../core/request-security.js";
import type { A2AHttpSignatureVerifiedWorker } from "../server.js";
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
  url: URL;
  broker: InMemoryA2ABroker;
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

function assertReadAccess(ctx: ReviewLineageRouteContext, action: string): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(
      ctx.requesterIdentity,
      [...REVIEW_LINEAGE_READ_ROLES],
      action,
    );
  }
}

type LineageMutationResult = Awaited<
  ReturnType<InMemoryA2ABroker["recordOperatorReviewLineageCancel"]>
>;

/**
 * Shared tail of every POST mutation on this surface: read the exact JSON
 * body, run the authenticated broker call, map adapter validation errors to
 * 400, map the closed result-status set to 404/409, and reply 200 (replayed)
 * or 201 (recorded). The per-route authentication gate stays at the call
 * site so each route's authority rule remains visible next to its path.
 */
async function recordLineageMutation(
  ctx: ReviewLineageRouteContext,
  label: string,
  record: (body: unknown) => Promise<LineageMutationResult>,
  options: { missingIs404: boolean },
): Promise<void> {
  const body = await readJson(ctx.req);
  if (!body) {
    throw new BrokerError("bad_request", "request body is required");
  }
  let result: LineageMutationResult;
  try {
    result = await record(body);
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
  if (options.missingIs404 && result.status === "missing_lineage") {
    throw new BrokerError("not_found", "review lineage not found");
  }
  if (
    result.status === "missing_lineage"
    || result.status === "subject_conflict"
    || result.status === "transition_rejected"
    || result.status === "idempotency_conflict"
  ) {
    throw new BrokerError(
      "invalid_transition",
      `review lineage ${label} rejected: ${result.status}`,
    );
  }
  sendJson(
    ctx.res,
    result.status === "replayed" ? 200 : 201,
    { result },
    { "cache-control": "no-store" },
  );
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
    await recordLineageMutation(
      ctx,
      "create",
      (body) =>
        ctx.broker.recordOperatorReviewLineageCreate(
          body,
          ctx.requesterIdentity!.id,
        ),
      { missingIs404: false },
    );
    return true;
  }

  const rest = ctx.path.slice("/review-lineages/".length);
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  if (
    ctx.method === "POST"
    && segments.length === 2
    && segments[1] === "reviewer-replacement"
    && rest === `${segments[0]}/reviewer-replacement`
  ) {
    // Only an authenticated exact-role operator may record an already
    // classified infrastructure-failure decision. Trusted broker code assigns
    // semantic reviewer-allocator authority after this unconditional gate.
    assertRequesterHasRole(
      ctx.requesterIdentity,
      ["operator"],
      "review-lineage.reviewer-replacement",
    );
    const lineageId = decodeURIComponent(segments[0]);
    await recordLineageMutation(
      ctx,
      "reviewer replacement",
      (body) =>
        ctx.broker.recordOperatorReviewLineageReviewerReplacement(
          lineageId,
          body,
          ctx.requesterIdentity!.id,
        ),
      { missingIs404: true },
    );
    return true;
  }
  if (
    ctx.method === "POST"
    && segments.length === 2
    && segments[1] === "correction-generation"
    && rest === `${segments[0]}/correction-generation`
  ) {
    // Only an authenticated exact-role operator may record an already
    // committed generation. The broker assigns semantic correction-controller
    // authority after this unconditional gate.
    assertRequesterHasRole(
      ctx.requesterIdentity,
      ["operator"],
      "review-lineage.correction-generation",
    );
    const lineageId = decodeURIComponent(segments[0]);
    await recordLineageMutation(
      ctx,
      "correction generation",
      (body) =>
        ctx.broker.recordOperatorReviewLineageCorrectionGeneration(
          lineageId,
          body,
          ctx.requesterIdentity!.id,
        ),
      { missingIs404: true },
    );
    return true;
  }
  if (
    ctx.method === "POST"
    && segments.length === 2
    && segments[1] === "review-report"
    && rest === `${segments[0]}/review-report`
  ) {
    // This source always requires an Ed25519 worker-registry result. Relaxed
    // requester identity cannot bypass it; a disabled signature verifier makes
    // the route unavailable rather than accepting an unsigned issuer.
    const verifiedReviewer =
      await ctx.assertWorkerHttpSignatureRoute(ctx.req, ctx.url);
    if (!verifiedReviewer) {
      throw new BrokerError(
        "unauthorized",
        "a2a_signature_required: review report requires A2A HTTP Signature",
      );
    }
    ctx.assertVerifiedWorkerMatches(
      verifiedReviewer,
      undefined,
      "review-lineage.report",
    );
    const lineageId = decodeURIComponent(segments[0]);
    await recordLineageMutation(
      ctx,
      "review report",
      (body) =>
        ctx.broker.recordReviewerReviewLineageReport(
          lineageId,
          body,
          verifiedReviewer.requesterId,
        ),
      { missingIs404: true },
    );
    return true;
  }
  if (
    ctx.method === "POST"
    && segments.length === 2
    && segments[1] === "operator-cancel"
    && rest === `${segments[0]}/operator-cancel`
  ) {
    // Unlike the broader read surface, the first authoritative source kind is
    // always identity-gated, including local/test configurations that relax
    // requester enforcement for legacy routes.
    assertRequesterHasRole(
      ctx.requesterIdentity,
      ["operator"],
      "review-lineage.operator-cancel",
    );
    const lineageId = decodeURIComponent(segments[0]);
    await recordLineageMutation(
      ctx,
      "operator cancel",
      (body) =>
        ctx.broker.recordOperatorReviewLineageCancel(
          lineageId,
          body,
          ctx.requesterIdentity!.id,
        ),
      { missingIs404: true },
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

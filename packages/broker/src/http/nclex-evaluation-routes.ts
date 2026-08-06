/**
 * NCLEX evaluation receipt routes (#1724).
 *
 * Default-off: the server registers these routes only when an evaluation
 * keyring is configured. Submission is operator-gated and fail-closed
 * (signature verification, self-review, malformed); the merge-ready
 * projection is read-only. No route here merges or touches a PR branch.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker-error.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";
import {
  verifySignedReceipt,
  type NclexEvaluationKeyring,
} from "../nclex-evaluation/receipt-contract.js";
import type { NclexEvaluationReceiptStore } from "../nclex-evaluation/receipt-store.js";
import { projectMergeReady } from "../nclex-evaluation/merge-ready.js";

const READ_ROLES = ["hub", "operator", "analyst", "researcher"] as const;

export interface NclexEvaluationRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  store: NclexEvaluationReceiptStore;
  keyring: NclexEvaluationKeyring;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
  /** Called after a NEW receipt is stored — wires durable persistence (#1724). */
  persistReceipts?: () => void;
}

function truthyParam(value: string | null, fallback: boolean): boolean {
  if (value === null || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export async function handleNclexEvaluationRoutesIfMatched(
  ctx: NclexEvaluationRouteContext,
): Promise<boolean> {
  if (!ctx.path.startsWith("/nclex-evaluations")) {
    return false;
  }

  if (ctx.method === "POST" && ctx.path === "/nclex-evaluations/receipts") {
    // Submission is operator-owned even when legacy requester enforcement is
    // relaxed: reviewer evidence enters the store only through this gate.
    assertRequesterHasRole(ctx.requesterIdentity, ["operator"], "nclex-evaluation.submit");
    const body = await readJson(ctx.req);
    if (!body) {
      throw new BrokerError("bad_request", "request body is required");
    }
    const verification = verifySignedReceipt(body, ctx.keyring);
    if (!verification.ok) {
      throw new BrokerError("bad_request", `receipt rejected: ${verification.reason}`);
    }
    const countBefore = ctx.store.count();
    const record = ctx.store.add(verification.receipt);
    if (ctx.store.count() > countBefore) {
      // A receipt is evidence: persist it immediately instead of waiting for
      // unrelated broker activity to carry it into the next snapshot.
      ctx.persistReceipts?.();
    }
    sendJson(ctx.res, 200, {
      kind: "nclex-evaluation-receipt",
      receiptId: record.receipt.receiptId,
      recordedAt: record.recordedAt,
    }, { "cache-control": "no-store" });
    return true;
  }

  const mergeReadyMatch = /^\/nclex-evaluations\/([^/]+)\/([^/]+)\/(\d+)\/merge-ready$/.exec(ctx.path);
  if (ctx.method === "GET" && mergeReadyMatch) {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, [...READ_ROLES], "nclex-evaluation.merge-ready");
    }
    const [, owner, name, prText] = mergeReadyMatch;
    const repo = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
    const prNumber = Number(prText);
    const headSha = ctx.url.searchParams.get("headSha");
    if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new BrokerError("bad_request", "headSha query parameter must be a 40-char hex SHA");
    }
    const riskParam = ctx.url.searchParams.get("risk") ?? "normal";
    if (riskParam !== "normal" && riskParam !== "high-risk") {
      throw new BrokerError("bad_request", "risk must be normal|high-risk");
    }
    const records = ctx.store.listByPr(repo, prNumber);
    const projection = projectMergeReady(records, {
      currentHeadSha: headSha.toLowerCase(),
      risk: riskParam,
      gateGreen: truthyParam(ctx.url.searchParams.get("gateGreen"), false),
      authorDistinctApproval: truthyParam(ctx.url.searchParams.get("authorDistinctApproval"), false),
      mergeConflict: truthyParam(ctx.url.searchParams.get("mergeConflict"), false),
    });
    sendJson(ctx.res, 200, {
      kind: "nclex-evaluation-merge-ready",
      repo,
      prNumber,
      receiptCount: records.length,
      ...projection,
    }, { "cache-control": "no-store" });
    return true;
  }

  if (ctx.method === "GET" && ctx.path === "/nclex-evaluations/receipts") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, [...READ_ROLES], "nclex-evaluation.list");
    }
    const records = ctx.store.listAll();
    sendJson(ctx.res, 200, {
      kind: "nclex-evaluation-receipts",
      count: records.length,
      receipts: records.map((record) => ({
        receiptId: record.receipt.receiptId,
        repo: record.receipt.repo,
        prNumber: record.receipt.prNumber,
        headSha: record.receipt.headSha,
        reviewerNodeId: record.receipt.reviewerNodeId,
        team: record.receipt.team,
        lane: record.receipt.lane,
        verdict: record.receipt.verdict,
        producedAt: record.receipt.producedAt,
        recordedAt: record.recordedAt,
      })),
    }, { "cache-control": "no-store" });
    return true;
  }

  throw new BrokerError("not_found", "not found");
}

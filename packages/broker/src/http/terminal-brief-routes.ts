import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import {
  buildTerminalBriefCloseoutGate,
  extractTerminalBriefFinalizerWorkflowPacket,
} from "../core/terminal-brief-closeout-gate.js";
import {
  buildTerminalBriefApprovalRequest,
  extractTerminalBriefCloseoutGatePacket,
} from "../core/terminal-brief-approval-request.js";
import {
  buildTerminalBriefApprovalExecutor,
  extractTerminalBriefApprovalRequestPacket,
} from "../core/terminal-brief-approval-executor.js";
import {
  buildTerminalBriefApprovalDispatchAdapter,
  extractTerminalBriefApprovalExecutorPacket,
} from "../core/terminal-brief-approval-dispatch-adapter.js";
import {
  buildTerminalBriefApprovalReceiptIngestor,
  extractTerminalBriefApprovalDispatchAdapterPacket,
  extractTerminalBriefApprovalReceiptEvidence,
} from "../core/terminal-brief-approval-receipt-ingestor.js";
import {
  buildTerminalBriefFinalizerApprovalStatus,
  extractTerminalBriefFinalizerApprovalReceiptStatus,
  extractTerminalBriefFinalizerApprovalStatusDispatch,
} from "../core/terminal-brief-finalizer-approval-status.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export const TERMINAL_BRIEF_CLOSEOUT_ROUTE_PATHS = [
  "/terminal-brief/closeout/gate",
  "/terminal-brief/closeout/approval-request",
  "/terminal-brief/closeout/approval-executor",
  "/terminal-brief/closeout/approval-dispatch",
  "/terminal-brief/closeout/approval-receipt",
  "/terminal-brief/closeout/finalizer-approval-status",
] as const;

export interface TerminalBriefCloseoutRoutesContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function maxAgeMsFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Source-only Terminal Brief closeout POST routes extracted from server.ts (#858).
 * Returns true only when one of the closeout route paths is handled.
 */
export async function handleTerminalBriefCloseoutRoutesIfMatched(
  ctx: TerminalBriefCloseoutRoutesContext,
): Promise<boolean> {
  if (ctx.method === "POST" && ctx.path === "/terminal-brief/closeout/gate") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.closeout_gate.read");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let workflow;
    try {
      workflow = extractTerminalBriefFinalizerWorkflowPacket(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid closeout gate input";
      throw new BrokerError("bad_request", message);
    }
    const report = buildTerminalBriefCloseoutGate(workflow, {
      issueUrl: optionalString(ctx.url.searchParams.get("issueUrl") ?? ctx.url.searchParams.get("issue_url")),
      prUrl: optionalString(ctx.url.searchParams.get("prUrl") ?? ctx.url.searchParams.get("pr_url")),
    });
    sendJson(ctx.res, 200, report, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/terminal-brief/closeout/approval-request") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.approval_request.read");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let gate;
    try {
      gate = extractTerminalBriefCloseoutGatePacket(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid approval request input";
      throw new BrokerError("bad_request", message);
    }
    const report = buildTerminalBriefApprovalRequest(gate);
    sendJson(ctx.res, 200, report, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/terminal-brief/closeout/approval-executor") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.approval_executor.read");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let approvalRequest;
    try {
      approvalRequest = extractTerminalBriefApprovalRequestPacket(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid approval executor input";
      throw new BrokerError("bad_request", message);
    }
    const executorOptions = body ?? {};
    const report = buildTerminalBriefApprovalExecutor(approvalRequest, {
      selectedAction: optionalString(executorOptions.selectedAction ?? executorOptions.selected_action),
      selectedTarget: optionalString(executorOptions.selectedTarget ?? executorOptions.selected_target),
      attemptExecute: executorOptions.attemptExecute === true || executorOptions.attempt_execute === true,
    });
    sendJson(ctx.res, 200, report, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/terminal-brief/closeout/approval-dispatch") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.approval_dispatch.read");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let approvalExecutor;
    try {
      approvalExecutor = extractTerminalBriefApprovalExecutorPacket(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid approval dispatch input";
      throw new BrokerError("bad_request", message);
    }
    const dispatchOptions = body ?? {};
    const report = buildTerminalBriefApprovalDispatchAdapter(approvalExecutor, {
      adapter: optionalString(dispatchOptions.adapter ?? dispatchOptions.adapter_type ?? dispatchOptions.adapterType),
      target: optionalString(dispatchOptions.target),
      channel: optionalString(dispatchOptions.channel),
      requestedBy: optionalString(dispatchOptions.requestedBy ?? dispatchOptions.requested_by),
      receiptId: optionalString(dispatchOptions.receiptId ?? dispatchOptions.receipt_id),
    });
    sendJson(ctx.res, 200, report, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/terminal-brief/closeout/approval-receipt") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.approval_receipt.read");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let approvalDispatch;
    try {
      approvalDispatch = extractTerminalBriefApprovalDispatchAdapterPacket(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid approval receipt input";
      throw new BrokerError("bad_request", message);
    }
    const receiptOptions = body ?? {};
    const report = buildTerminalBriefApprovalReceiptIngestor(
      approvalDispatch,
      extractTerminalBriefApprovalReceiptEvidence(body),
      { maxAgeMs: maxAgeMsFrom(receiptOptions.maxAgeMs ?? receiptOptions.max_age_ms) },
    );
    sendJson(ctx.res, 200, report, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/terminal-brief/closeout/finalizer-approval-status") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.finalizer_approval_status.read");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let approvalDispatch;
    try {
      approvalDispatch = extractTerminalBriefFinalizerApprovalStatusDispatch(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid finalizer approval status input";
      throw new BrokerError("bad_request", message);
    }
    const report = buildTerminalBriefFinalizerApprovalStatus(
      approvalDispatch,
      extractTerminalBriefFinalizerApprovalReceiptStatus(body),
    );
    sendJson(ctx.res, 200, report, {
      "cache-control": "no-store",
    });
    return true;
  }

  return false;
}

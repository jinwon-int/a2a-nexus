/**
 * Dry-run approval packet projection — evidence ≠ approval, no live send.
 *
 * Issue:  jinwon-int/plugin-a2a#256
 * Parent: a2a-plane#197 (internal tracker, private)
 * Run:    a2a-source-dryrun-orchestrator-20260510T133022Z
 *
 * Projects what an a2a.task.approve or a2a.task.reject_approval broker request
 * would look like without ever sending it. Returns an evidence packet with
 * explicit operator status metadata.
 *
 * Safety gates:
 *  - Never sends HTTP to a broker
 *  - Always marks projections as dry-run (evidence, not approval)
 *  - Preserves accepted-send non-ACK semantics
 *  - Fail-closed: rejects invalid params before projection
 */
import {
  resolveA2ABrokerAdapterPluginConfig,
  type A2ABrokerAdapterPluginRuntimeConfig,
  type ResolvedA2ABrokerAdapterPluginConfig,
} from "../config.js";
import type { A2ABrokerPartyRef } from "../standalone-broker-client.js";
import {
  validateA2ATaskApproveParams,
  validateA2ATaskRejectApprovalParams,
} from "./gateway-validators.js";
import { normalizeOptionalString } from "./value-guards.js";

// ── Public types ────────────────────────────────────────────────────

export type ApprovalDryRunAction = "approve" | "reject_approval";

export type ApprovalDryRunOperatorStatus = {
  /**
   * Whether operator configuration explicitly enables approvals.
   * When false, the approval would fail-closed at the gateway handler.
   */
  operatorConfigured: boolean;
  /**
   * Whether the resolved config has a baseUrl for broker communication.
   */
  brokerReachable: boolean;
  /**
   * Whether the operator has explicitly activated the plugin.
   */
  pluginActive: boolean;
  /**
   * Human-readable summary of operator readiness.
   */
  summary: string;
};

export type ApprovalDryRunProjectedPacket = {
  /** Target broker endpoint path (projected, not called). */
  endpoint: string;
  /** HTTP method that would be used. */
  method: "POST";
  /** Full projected request body (Zod-parsed shape). */
  body: {
    actor: A2ABrokerPartyRef;
    reason?: string;
    approvalId?: string;
    status?: "rejected" | "expired" | "canceled";
  };
  /** Request headers that would be sent (without secrets). */
  headers: {
    "content-type": "application/json";
    "x-a2a-requester-id"?: string;
    "x-a2a-requester-kind"?: string;
  };
};

export type ApprovalDryRunEvidence = {
  /** Schema version for evidence packets. */
  schema: "a2a.approval.dry-run.evidence";
  version: 1;
  /** The action that was projected (approve or reject_approval). */
  action: ApprovalDryRunAction;
  /** The task ID the approval targets. */
  taskId: string;
  /** When the projection was generated (epoch ms). */
  projectedAt: number;
  /** The projected broker request packet. Evidence, NOT an actual approval. */
  projectedPacket: ApprovalDryRunProjectedPacket;
  /** Operator status at projection time. */
  operatorStatus: ApprovalDryRunOperatorStatus;
  /** Run identifier for traceability. */
  runId: string;
};

export type ApprovalDryRunResult = {
  /** Always true for valid inputs; false means rejected. */
  ok: true;
  /** The dry-run evidence packet. This is NOT an approval — it's a projection. */
  evidence: ApprovalDryRunEvidence;
  /**
   * Explicit marker: evidence is not approval.
   * The projectedPacket above shows what WOULD be sent, but was NOT sent.
   */
  isApproval: false;
  /** Always true; confirms no live broker call was made. */
  dryRun: true;
  /** Always false; production approval is never performed. */
  liveSend: false;
};

export type ApprovalDryRunError = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
  isApproval: false;
  dryRun: true;
  liveSend: false;
};

export type ApprovalDryRunOutcome = ApprovalDryRunResult | ApprovalDryRunError;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Project a dry-run approval packet for a2a.task.approve.
 *
 * Validates params, resolves operator status, and builds an evidence packet
 * showing what the broker request WOULD look like — without ever sending it.
 *
 * This is evidence tooling only. The returned `evidence.projectedPacket` is a
 * projection, NOT an actual approval. `liveSend` is always `false`.
 *
 * @param params  Raw approval params (may be partial; validated internally)
 * @param config  Plugin runtime config for operator status resolution
 * @param deps    Optional overrides for sessionKey and runId
 * @returns       Dry-run evidence or validation error
 */
export function projectApprovalDryRun(
  params: unknown,
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: {
    sessionKey?: string;
    runId?: string;
    now?: () => number;
  } = {},
): ApprovalDryRunOutcome {
  const now = deps.now ?? Date.now;
  const runId = deps.runId ?? `a2a-approval-dryrun-${now()}`;

  const validated = validateA2ATaskApproveParams(params);
  if (!validated) {
    return {
      ok: false,
      error: buildValidationError("a2a.task.approve", validateA2ATaskApproveParams),
      isApproval: false,
      dryRun: true,
      liveSend: false,
    };
  }

  const resolved = resolveA2ABrokerAdapterPluginConfig(config);
  const operatorStatus = resolveOperatorStatus(resolved);

  const actor = resolveApprovalActor(resolved, params.sessionKey ?? deps.sessionKey);

  const projectedPacket: ApprovalDryRunProjectedPacket = {
    endpoint: `/tasks/${encodeURIComponent(params.approval.taskId)}/approve`,
    method: "POST",
    body: {
      actor: stripOptionalFields(actor),
      ...(normalizeOptionalString(params.approval.reason)
        ? { reason: normalizeOptionalString(params.approval.reason) }
        : {}),
      ...(normalizeOptionalString(params.approval.approvalId)
        ? { approvalId: normalizeOptionalString(params.approval.approvalId) }
        : {}),
    },
    headers: {
      "content-type": "application/json",
      ...(actor.id ? { "x-a2a-requester-id": actor.id } : {}),
      ...(actor.kind ? { "x-a2a-requester-kind": actor.kind } : {}),
    },
  };

  return {
    ok: true,
    evidence: {
      schema: "a2a.approval.dry-run.evidence",
      version: 1,
      action: "approve",
      taskId: params.approval.taskId,
      projectedAt: now(),
      projectedPacket,
      operatorStatus,
      runId,
    },
    isApproval: false,
    dryRun: true,
    liveSend: false,
  };
}

/**
 * Project a dry-run rejection packet for a2a.task.reject_approval.
 *
 * Same evidence-tooling semantics as {@link projectApprovalDryRun}: builds a
 * projection of the reject-approval broker request without ever sending it.
 *
 * @param params  Raw reject-approval params (may be partial; validated internally)
 * @param config  Plugin runtime config for operator status resolution
 * @param deps    Optional overrides for sessionKey and runId
 * @returns       Dry-run evidence or validation error
 */
export function projectRejectApprovalDryRun(
  params: unknown,
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: {
    sessionKey?: string;
    runId?: string;
    now?: () => number;
  } = {},
): ApprovalDryRunOutcome {
  const now = deps.now ?? Date.now;
  const runId = deps.runId ?? `a2a-reject-dryrun-${now()}`;

  const validated = validateA2ATaskRejectApprovalParams(params);
  if (!validated) {
    return {
      ok: false,
      error: buildValidationError("a2a.task.reject_approval", validateA2ATaskRejectApprovalParams),
      isApproval: false,
      dryRun: true,
      liveSend: false,
    };
  }

  const resolved = resolveA2ABrokerAdapterPluginConfig(config);
  const operatorStatus = resolveOperatorStatus(resolved);

  const actor = resolveApprovalActor(resolved, params.sessionKey ?? deps.sessionKey);

  const projectedPacket: ApprovalDryRunProjectedPacket = {
    endpoint: `/tasks/${encodeURIComponent(params.approval.taskId)}/reject-approval`,
    method: "POST",
    body: {
      actor: stripOptionalFields(actor),
      ...(normalizeOptionalString(params.approval.reason)
        ? { reason: normalizeOptionalString(params.approval.reason) }
        : {}),
      ...(normalizeOptionalString(params.approval.approvalId)
        ? { approvalId: normalizeOptionalString(params.approval.approvalId) }
        : {}),
      ...(params.approval.status ? { status: params.approval.status } : {}),
    },
    headers: {
      "content-type": "application/json",
      ...(actor.id ? { "x-a2a-requester-id": actor.id } : {}),
      ...(actor.kind ? { "x-a2a-requester-kind": actor.kind } : {}),
    },
  };

  return {
    ok: true,
    evidence: {
      schema: "a2a.approval.dry-run.evidence",
      version: 1,
      action: "reject_approval",
      taskId: params.approval.taskId,
      projectedAt: now(),
      projectedPacket,
      operatorStatus,
      runId,
    },
    isApproval: false,
    dryRun: true,
    liveSend: false,
  };
}

// ── Operator status ─────────────────────────────────────────────────

function resolveOperatorStatus(
  resolved: ResolvedA2ABrokerAdapterPluginConfig,
): ApprovalDryRunOperatorStatus {
  const operatorConfigured = resolved.explicitlyActivated;
  const brokerReachable = Boolean(resolved.baseUrl);
  const pluginActive = resolved.enabled;

  let summary: string;
  if (!pluginActive) {
    summary = "plugin disabled — approval would fail-closed at gateway handler";
  } else if (!brokerReachable) {
    summary = "no broker baseUrl configured — approval would fail with BROKER_UNAVAILABLE";
  } else if (!operatorConfigured) {
    summary = "plugin not explicitly activated — approval may be rejected";
  } else {
    summary = "operator ready — approval packet projected (not sent)";
  }

  return {
    operatorConfigured,
    brokerReachable,
    pluginActive,
    summary,
  };
}

// ── Actor resolution ────────────────────────────────────────────────

function resolveApprovalActor(
  resolved: ResolvedA2ABrokerAdapterPluginConfig,
  sessionKey?: string,
): A2ABrokerPartyRef {
  if (resolved.requester) {
    return resolved.requester;
  }
  const id = sessionKey ?? "unknown-session";
  return {
    id,
    kind: "session",
    role: "hub",
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildValidationError(
  method: string,
  validator: (data: unknown) => boolean,
): { code: string; message: string } {
  const errors = (validator as { errors?: Array<{ instancePath?: string; message?: string }> })
    .errors
    ?.map((e) => `${e.instancePath || "/"}: ${e.message}`)
    .join("; ");
  return {
    code: "INVALID_REQUEST",
    message: `invalid ${method} params: ${errors || "unknown validation error"}`,
  };
}
function stripOptionalFields(ref: A2ABrokerPartyRef): A2ABrokerPartyRef {
  const stripped: Record<string, unknown> = { id: ref.id };
  if (ref.kind) stripped.kind = ref.kind;
  if (ref.role) stripped.role = ref.role;
  if (ref.displayName) stripped.displayName = ref.displayName;
  return stripped as A2ABrokerPartyRef;
}

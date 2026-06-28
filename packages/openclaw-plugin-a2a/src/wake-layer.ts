import type { A2ABrokerTaskStatus } from "../standalone-broker-client.js";
import { normalizeOptionalString } from "./value-guards.js";

export type A2AWakeTargetRef = {
  sessionKey: string;
  displayKey?: string;
  channel?: string;
};

export type A2AWakeRequesterRef = {
  sessionKey?: string;
  displayKey?: string;
  channel?: string;
};

export type A2AWakeEnvelope = {
  taskId: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  brokerStatus: A2ABrokerTaskStatus;
  acceptedAtMs?: number;
  requester?: A2AWakeRequesterRef;
  target: A2AWakeTargetRef;
};

export type A2AWakeGuardConfig = {
  /** Wake-on-Task is intentionally opt-in until Phase 6 gates are green. */
  enabled?: boolean;
  localRunIds?: ReadonlySet<string>;
  perNodeRateLimit?: {
    /** Maximum scheduled wakes for the same target node/session within the window. */
    maxWakeCount: number;
    /** Sliding window in milliseconds. */
    windowMs: number;
    /** Optional deterministic clock for tests and replayed audit evaluation. */
    nowMs?: number;
  };
};

export type A2AWakeGuardState = {
  /** Recent deterministic wake keys used for duplicate suppression. */
  recentWakeKeys?: ReadonlySet<string>;
  /** Sessions that already have an active agent run and should be coalesced. */
  activeSessionKeys?: ReadonlySet<string>;
  /** Recent wake timestamps by target node/session key for rate limiting. */
  recentWakeTimestampsByTargetKey?: ReadonlyMap<string, readonly number[]>;
};

export type A2AWakeSkipCode =
  | "wake_disabled"
  | "terminal_task"
  | "missing_target"
  | "loop_guard"
  | "duplicate_wake"
  | "rate_limited";

export type A2AWakeFailureCode = "wake_dispatch_failed" | "wake_rejected";

export type A2AWakePlan =
  | {
      status: "scheduled";
      taskId: string;
      sessionKey: string;
      idempotencyKey: string;
      mode: "resume_or_launch" | "append_to_active_session";
      wakeKey: string;
      targetKey: string;
      correlationId?: string;
      coalesced: boolean;
    }
  | {
      status: "skipped";
      code: A2AWakeSkipCode;
      taskId?: string;
      sessionKey?: string;
      wakeKey?: string;
      reason: string;
    };

export type A2AScheduledWakePlan = Extract<A2AWakePlan, { status: "scheduled" }>;

export type A2AWakeRuntimeReceipt =
  | {
      accepted: true;
      runtimeRunId?: string;
      queuedAtMs?: number;
      note?: string;
    }
  | {
      accepted: false;
      code: string;
      message: string;
    };

export type A2AWakeRuntimePort = {
  dispatchWake: (params: {
    envelope: A2AWakeEnvelope;
    plan: A2AScheduledWakePlan;
  }) => A2AWakeRuntimeReceipt | Promise<A2AWakeRuntimeReceipt>;
};

export type A2AWakeAuditEvent = {
  kind: "a2a.wake";
  status: "skipped" | "scheduled" | "failed";
  taskId?: string;
  sessionKey?: string;
  wakeKey?: string;
  idempotencyKey?: string;
  correlationId?: string;
  code?: A2AWakeSkipCode | A2AWakeFailureCode | string;
  message: string;
  atMs: number;
  runtimeRunId?: string;
};

export type A2AWakeTaskAuditState = {
  taskId?: string;
  auditEvent: A2AWakeAuditEvent;
  taskStatePatch: {
    wake: {
      status: A2AWakeAuditEvent["status"];
      code?: A2AWakeAuditEvent["code"];
      message: string;
      atMs: number;
      wakeKey?: string;
      sessionKey?: string;
      idempotencyKey?: string;
      runtimeRunId?: string;
    };
  };
};

export type A2AWakeResult =
  | {
      status: "skipped";
      plan: Extract<A2AWakePlan, { status: "skipped" }>;
      audit: A2AWakeTaskAuditState;
    }
  | {
      status: "scheduled";
      plan: A2AScheduledWakePlan;
      receipt: Extract<A2AWakeRuntimeReceipt, { accepted: true }>;
      audit: A2AWakeTaskAuditState;
    }
  | {
      status: "failed";
      plan: A2AScheduledWakePlan;
      code: A2AWakeFailureCode;
      error: string;
      audit: A2AWakeTaskAuditState;
    };

const TERMINAL_BROKER_STATUSES = new Set<A2ABrokerTaskStatus>([
  "succeeded",
  "failed",
  "canceled",
]);
function buildWakeKey(envelope: A2AWakeEnvelope): string {
  const stableCorrelation =
    normalizeOptionalString(envelope.correlationId) ?? normalizeOptionalString(envelope.taskId);
  const stableRun =
    normalizeOptionalString(envelope.waitRunId) ?? normalizeOptionalString(envelope.target.sessionKey);
  return `${stableCorrelation}:${stableRun}`;
}

function buildTargetKey(envelope: A2AWakeEnvelope): string | undefined {
  return (
    normalizeOptionalString(envelope.target.displayKey) ??
    normalizeOptionalString(envelope.target.sessionKey)
  );
}

function isLoopCandidate(envelope: A2AWakeEnvelope, config: A2AWakeGuardConfig): boolean {
  const parentRunId = normalizeOptionalString(envelope.parentRunId);
  if (!parentRunId) {
    return false;
  }
  if (parentRunId === normalizeOptionalString(envelope.waitRunId)) {
    return true;
  }
  return config.localRunIds?.has(parentRunId) === true;
}

function isRateLimited(params: {
  targetKey: string;
  config: A2AWakeGuardConfig;
  state?: A2AWakeGuardState;
}): boolean {
  const limit = params.config.perNodeRateLimit;
  if (!limit) {
    return false;
  }
  if (limit.maxWakeCount <= 0) {
    return true;
  }
  if (limit.windowMs <= 0) {
    return false;
  }
  const nowMs = limit.nowMs ?? Date.now();
  const windowStartMs = nowMs - limit.windowMs;
  const recent = params.state?.recentWakeTimestampsByTargetKey?.get(params.targetKey) ?? [];
  const wakeCount = recent.filter((timestampMs) => timestampMs >= windowStartMs).length;
  return wakeCount >= limit.maxWakeCount;
}

function buildAudit(params: {
  status: A2AWakeAuditEvent["status"];
  taskId?: string;
  sessionKey?: string;
  wakeKey?: string;
  idempotencyKey?: string;
  correlationId?: string;
  code?: A2AWakeAuditEvent["code"];
  message: string;
  atMs?: number;
  runtimeRunId?: string;
}): A2AWakeTaskAuditState {
  const auditEvent: A2AWakeAuditEvent = {
    kind: "a2a.wake",
    status: params.status,
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.wakeKey ? { wakeKey: params.wakeKey } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.code ? { code: params.code } : {}),
    message: params.message,
    atMs: params.atMs ?? Date.now(),
    ...(params.runtimeRunId ? { runtimeRunId: params.runtimeRunId } : {}),
  };
  return {
    taskId: params.taskId,
    auditEvent,
    taskStatePatch: {
      wake: {
        status: auditEvent.status,
        ...(auditEvent.code ? { code: auditEvent.code } : {}),
        message: auditEvent.message,
        atMs: auditEvent.atMs,
        ...(auditEvent.wakeKey ? { wakeKey: auditEvent.wakeKey } : {}),
        ...(auditEvent.sessionKey ? { sessionKey: auditEvent.sessionKey } : {}),
        ...(auditEvent.idempotencyKey ? { idempotencyKey: auditEvent.idempotencyKey } : {}),
        ...(auditEvent.runtimeRunId ? { runtimeRunId: auditEvent.runtimeRunId } : {}),
      },
    },
  };
}

export function evaluateA2AWakePlan(params: {
  envelope: A2AWakeEnvelope;
  config?: A2AWakeGuardConfig;
  state?: A2AWakeGuardState;
}): A2AWakePlan {
  const config = params.config ?? {};
  const envelope = params.envelope;
  const taskId = normalizeOptionalString(envelope.taskId);
  const sessionKey = normalizeOptionalString(envelope.target.sessionKey);

  if (config.enabled !== true) {
    return {
      status: "skipped",
      code: "wake_disabled",
      taskId,
      sessionKey,
      reason: "Wake-on-Task is disabled by default until Phase 6 gates are green.",
    };
  }

  if (TERMINAL_BROKER_STATUSES.has(envelope.brokerStatus)) {
    return {
      status: "skipped",
      code: "terminal_task",
      taskId,
      sessionKey,
      reason: `Broker task is already terminal (${envelope.brokerStatus}).`,
    };
  }

  if (!taskId || !sessionKey) {
    return {
      status: "skipped",
      code: "missing_target",
      taskId,
      sessionKey,
      reason: "Wake envelope requires a taskId and target.sessionKey.",
    };
  }

  if (isLoopCandidate(envelope, config)) {
    return {
      status: "skipped",
      code: "loop_guard",
      taskId,
      sessionKey,
      reason: "Wake request points back at an active parent run.",
    };
  }

  const wakeKey = buildWakeKey(envelope);
  if (params.state?.recentWakeKeys?.has(wakeKey)) {
    return {
      status: "skipped",
      code: "duplicate_wake",
      taskId,
      sessionKey,
      wakeKey,
      reason: "Wake key was already scheduled recently.",
    };
  }

  const targetKey = buildTargetKey(envelope) ?? sessionKey;
  if (isRateLimited({ targetKey, config, state: params.state })) {
    return {
      status: "skipped",
      code: "rate_limited",
      taskId,
      sessionKey,
      wakeKey,
      reason: "Target node/session exceeded the Wake-on-Task rate limit.",
    };
  }

  const coalesced = params.state?.activeSessionKeys?.has(sessionKey) === true;
  return {
    status: "scheduled",
    taskId,
    sessionKey,
    idempotencyKey: `a2a-wake:${wakeKey}`,
    mode: coalesced ? "append_to_active_session" : "resume_or_launch",
    wakeKey,
    targetKey,
    ...(normalizeOptionalString(envelope.correlationId)
      ? { correlationId: normalizeOptionalString(envelope.correlationId) }
      : {}),
    coalesced,
  };
}

export async function executeA2AWake(params: {
  envelope: A2AWakeEnvelope;
  runtime: A2AWakeRuntimePort;
  config?: A2AWakeGuardConfig;
  state?: A2AWakeGuardState;
  nowMs?: number;
}): Promise<A2AWakeResult> {
  const plan = evaluateA2AWakePlan({
    envelope: params.envelope,
    config: params.config,
    state: params.state,
  });
  const atMs = params.nowMs ?? params.config?.perNodeRateLimit?.nowMs ?? Date.now();

  if (plan.status === "skipped") {
    return {
      status: "skipped",
      plan,
      audit: buildAudit({
        status: "skipped",
        taskId: plan.taskId,
        sessionKey: plan.sessionKey,
        wakeKey: plan.wakeKey,
        code: plan.code,
        message: plan.reason,
        atMs,
      }),
    };
  }

  try {
    const receipt = await params.runtime.dispatchWake({ envelope: params.envelope, plan });
    if (!receipt.accepted) {
      return {
        status: "failed",
        plan,
        code: "wake_rejected",
        error: receipt.message,
        audit: buildAudit({
          status: "failed",
          taskId: plan.taskId,
          sessionKey: plan.sessionKey,
          wakeKey: plan.wakeKey,
          idempotencyKey: plan.idempotencyKey,
          correlationId: plan.correlationId,
          code: receipt.code || "wake_rejected",
          message: receipt.message,
          atMs,
        }),
      };
    }
    return {
      status: "scheduled",
      plan,
      receipt,
      audit: buildAudit({
        status: "scheduled",
        taskId: plan.taskId,
        sessionKey: plan.sessionKey,
        wakeKey: plan.wakeKey,
        idempotencyKey: plan.idempotencyKey,
        correlationId: plan.correlationId,
        message: receipt.note ?? "Wake-on-Task scheduled.",
        atMs: receipt.queuedAtMs ?? atMs,
        runtimeRunId: receipt.runtimeRunId,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      plan,
      code: "wake_dispatch_failed",
      error: message,
      audit: buildAudit({
        status: "failed",
        taskId: plan.taskId,
        sessionKey: plan.sessionKey,
        wakeKey: plan.wakeKey,
        idempotencyKey: plan.idempotencyKey,
        correlationId: plan.correlationId,
        code: "wake_dispatch_failed",
        message,
        atMs,
      }),
    };
  }
}

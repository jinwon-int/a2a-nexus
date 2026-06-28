import type { A2ABrokerTaskRecord } from "../standalone-broker-client.js";
import { normalizeOptionalString } from "./value-guards.js";
import {
  executeA2AWake,
  type A2AWakeEnvelope,
  type A2AWakeGuardConfig,
  type A2AWakeGuardState,
  type A2AWakeResult,
  type A2AWakeRuntimePort,
} from "./wake-layer.js";

export type A2AWakeEnvelopeFallback = {
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  requesterSessionKey?: string;
  requesterDisplayKey?: string;
  requesterChannel?: string;
  targetSessionKey?: string;
  targetDisplayKey?: string;
  targetChannel?: string;
};

export type A2AWakeAfterAcceptanceOptions = {
  config?: A2AWakeGuardConfig;
  state?: A2AWakeGuardState;
  runtime?: A2AWakeRuntimePort;
  nowMs?: number;
  onResult?: (params: {
    envelope: A2AWakeEnvelope;
    result: A2AWakeResult;
  }) => void | Promise<void>;
};

const runtimeUnavailableWakePort: A2AWakeRuntimePort = {
  dispatchWake: () => ({
    accepted: false,
    code: "wake_runtime_unconfigured",
    message: "Wake runtime is not configured.",
  }),
};
function readPayloadRecord(task: A2ABrokerTaskRecord): Record<string, unknown> {
  return task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
    ? (task.payload as Record<string, unknown>)
    : {};
}

function parseOptionalEpochMs(value: unknown): number | undefined {
  const text = normalizeOptionalString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildA2AWakeEnvelopeFromAcceptedTask(params: {
  task: A2ABrokerTaskRecord;
  fallback?: A2AWakeEnvelopeFallback;
}): A2AWakeEnvelope {
  const payload = readPayloadRecord(params.task);
  const fallback = params.fallback ?? {};
  const targetSessionKey =
    normalizeOptionalString(payload.targetSessionKey) ??
    normalizeOptionalString(fallback.targetSessionKey) ??
    normalizeOptionalString(params.task.target.id) ??
    params.task.id;
  const targetDisplayKey =
    normalizeOptionalString(payload.targetDisplayKey) ??
    normalizeOptionalString(fallback.targetDisplayKey) ??
    normalizeOptionalString(params.task.targetNodeId) ??
    normalizeOptionalString(params.task.assignedWorkerId) ??
    normalizeOptionalString(params.task.target.id);
  const targetChannel =
    normalizeOptionalString(payload.targetChannel) ?? normalizeOptionalString(fallback.targetChannel);
  const requesterSessionKey =
    normalizeOptionalString(payload.requesterSessionKey) ??
    normalizeOptionalString(fallback.requesterSessionKey);
  const requesterDisplayKey =
    normalizeOptionalString(payload.requesterDisplayKey) ??
    normalizeOptionalString(fallback.requesterDisplayKey) ??
    normalizeOptionalString(params.task.requester.id);
  const requesterChannel =
    normalizeOptionalString(payload.requesterChannel) ??
    normalizeOptionalString(fallback.requesterChannel);

  return {
    taskId: params.task.id,
    ...(normalizeOptionalString(payload.waitRunId) ?? normalizeOptionalString(fallback.waitRunId)
      ? { waitRunId: normalizeOptionalString(payload.waitRunId) ?? normalizeOptionalString(fallback.waitRunId) }
      : {}),
    ...(normalizeOptionalString(payload.correlationId) ?? normalizeOptionalString(fallback.correlationId)
      ? {
          correlationId:
            normalizeOptionalString(payload.correlationId) ??
            normalizeOptionalString(fallback.correlationId),
        }
      : {}),
    ...(normalizeOptionalString(payload.parentRunId) ?? normalizeOptionalString(fallback.parentRunId)
      ? {
          parentRunId:
            normalizeOptionalString(payload.parentRunId) ?? normalizeOptionalString(fallback.parentRunId),
        }
      : {}),
    brokerStatus: params.task.status,
    ...(parseOptionalEpochMs(params.task.createdAt)
      ? { acceptedAtMs: parseOptionalEpochMs(params.task.createdAt) }
      : {}),
    ...(requesterSessionKey || requesterDisplayKey || requesterChannel
      ? {
          requester: {
            ...(requesterSessionKey ? { sessionKey: requesterSessionKey } : {}),
            ...(requesterDisplayKey ? { displayKey: requesterDisplayKey } : {}),
            ...(requesterChannel ? { channel: requesterChannel } : {}),
          },
        }
      : {}),
    target: {
      sessionKey: targetSessionKey,
      ...(targetDisplayKey ? { displayKey: targetDisplayKey } : {}),
      ...(targetChannel ? { channel: targetChannel } : {}),
    },
  };
}

export async function runA2AWakeAfterTaskAcceptance(params: {
  task: A2ABrokerTaskRecord;
  fallback?: A2AWakeEnvelopeFallback;
  wake?: A2AWakeAfterAcceptanceOptions;
}): Promise<A2AWakeResult> {
  const envelope = buildA2AWakeEnvelopeFromAcceptedTask({
    task: params.task,
    fallback: params.fallback,
  });
  const result = await executeA2AWake({
    envelope,
    runtime: params.wake?.runtime ?? runtimeUnavailableWakePort,
    config: params.wake?.config,
    state: params.wake?.state,
    nowMs: params.wake?.nowMs,
  });
  try {
    await params.wake?.onResult?.({ envelope, result });
  } catch {
    // Wake visibility callbacks are best-effort and must not change sessions_send behavior.
  }
  return result;
}

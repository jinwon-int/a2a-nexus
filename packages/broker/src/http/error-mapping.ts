import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";

import { sendJson } from "./response.js";

export function sendError(res: ServerResponse<IncomingMessage>, error: unknown): void {
  if (error instanceof BrokerError) {
    const status = statusCodeFor(error.code);
    sendJson(res, status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  sendJson(res, 500, {
    error: {
      code: "internal_error",
      message: "internal error",
    },
  });
}

export async function awaitDurablePersistenceAck(stateStore: BrokerStateStore): Promise<void> {
  const awaitAck = stateStore.awaitDurablePersistenceAck;
  if (!awaitAck) {
    return;
  }
  try {
    await awaitAck.call(stateStore);
  } catch (error) {
    throw normalizeDurablePersistenceAckError(error);
  }
}

export function normalizeDurablePersistenceAckError(error: unknown): unknown {
  if (error instanceof BrokerError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = durablePersistenceAckErrorCode(message);
  if (code) {
    return new BrokerError(code, message);
  }
  return error;
}

export function durablePersistenceAckErrorCode(message: string): BrokerError["code"] | undefined {
  if (/\bqueue_saturated\b/.test(message)) {
    return "queue_saturated";
  }
  if (/\bqueue_drain_timeout\b/.test(message)) {
    return "queue_drain_timeout";
  }
  if (/\bqueue_closed\b/.test(message)) {
    return "queue_closed";
  }
  if (/\bworker_crashed\b|\bworker_exited_\d+\b/.test(message)) {
    return "worker_crashed";
  }
  if (/\bworker_unavailable\b/.test(message)) {
    return "worker_unavailable";
  }
  return undefined;
}

export function statusCodeFor(code: BrokerError["code"]): number {
  switch (code) {
    case "bad_request":
    case "spec_underspecified":
      return 400;
    case "unauthorized":
      return 401;
    case "policy_denied":
      return 403;
    case "not_found":
      return 404;
    case "invalid_transition":
      return 409;
    case "github_completion_evidence_missing":
    case "github_completion_receipt_invalid":
      return 400;
    case "rate_limited":
      return 429;
    case "queue_saturated":
    case "queue_drain_timeout":
    case "queue_closed":
    case "worker_crashed":
    case "worker_unavailable":
      return 503;
    default:
      throw new Error("unhandled broker error code");
  }
}

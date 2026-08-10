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

/**
 * Map a BrokerError code onto an HTTP status.
 *
 * Two invariants, both learned the hard way (#1518, routed from #1725 finding 3):
 *
 * 1. **Never throw.** The only caller is `sendError`, which runs inside the
 *    request handler's `catch` block (`server.ts`). The handler is `async`, so
 *    a throw there rejects the handler promise instead of propagating: Node
 *    never writes a response, the client hangs until its own timeout, and the
 *    broker only logs an `unhandledRejection`. The process survives, so the
 *    failure is silent — a dispatcher just stops getting answers. Before this
 *    was fixed, `POST /tasks` with a review-author conflict reproduced exactly
 *    that. The A2A JSON-RPC sibling mapper (`a2a/json-rpc.ts`,
 *    `brokerErrorMapping`) already documents and follows this rule.
 * 2. **Stay exhaustive at compile time.** The `never` assignment below turns a
 *    newly added `BrokerErrorCode` into a build error, so an unmapped code is
 *    caught in CI rather than as a hung socket in production. The runtime
 *    fallback stays as defense in depth for untyped JS callers.
 */
export function statusCodeFor(code: BrokerError["code"]): number {
  switch (code) {
    case "bad_request":
    case "spec_underspecified":
    case "source_projection_empty":
    case "acceptance_malformed":
    case "provenance_invalid":
    case "retry_policy_malformed":
      return 400;
    case "unauthorized":
      return 401;
    case "policy_denied":
      return 403;
    case "not_found":
      return 404;
    // Conflicts with the task's current state. `unsupported_operation` and
    // `task_lineage_cycle` are raised on the A2A JSON-RPC surface today, but
    // they are mapped here so the REST surface cannot regress into the hang
    // described above if a future route throws them.
    case "invalid_transition":
    case "unsupported_operation":
    case "task_lineage_cycle":
      return 409;
    case "content_type_not_supported":
      return 415;
    case "github_completion_evidence_missing":
    case "github_completion_receipt_invalid":
    case "review_evidence_missing":
    case "review_not_independent":
    case "review_verdict_failed":
    case "review_author_conflict":
    case "finalizer_verdict_invalid":
      return 400;
    case "rate_limited":
      return 429;
    case "queue_saturated":
    case "queue_drain_timeout":
    case "queue_closed":
    case "worker_crashed":
    case "worker_unavailable":
      return 503;
    default: {
      // Compile-time exhaustiveness: adding a BrokerErrorCode without mapping
      // it fails the build here.
      const unmapped: never = code;
      void unmapped;
      // Runtime fail-safe: an untyped caller gets a generic 500, never a throw.
      return 500;
    }
  }
}

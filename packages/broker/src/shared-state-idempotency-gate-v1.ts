/**
 * Task-create idempotency gate for #1504 §4 Slice V — the wiring layer
 * between `InMemoryA2ABroker.createTask` and the fence-mediated V1
 * `executeIdempotent` primitive on the §5.4.1 `broker.task.create` authority.
 *
 * The authority is injected into the broker core as a single function so the
 * core stays V1-agnostic; it REPLACES the legacy same-ID replay check when
 * the default-off `BROKER_SHARED_STATE_V1_IDEMPOTENCY` flag is `on` (§5.4.1:
 * never layer a second independent decision over the current authority). The
 * local `getTask` mirror only routes; the V1 authority always decides.
 *
 * Failure mapping (§5.4 partition behavior): a same key presented with a
 * different payload fingerprint is `idempotency_conflict` (409) — the one
 * thing idempotency must never absorb — and an unavailable authority fails
 * the create with retryable `state_unavailable` (503); the protected mutation
 * must not run when the authoritative record cannot be read or committed.
 */

import { createHash } from "node:crypto";

import { BrokerError } from "./core/broker-error.js";
import type { SharedStateServingFenceV1 } from "./shared-state-serving-fence-v1.js";

export type TaskCreateIdempotencyDecisionV1 =
  | { readonly outcome: "executed" }
  | { readonly outcome: "replayed" };

/**
 * Deterministic JSON serialization with recursively sorted object keys, so
 * the payload fingerprint of a retried create is stable across processes and
 * property insertion order.
 */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonString(item)}`).join(",")}}`;
}

/**
 * Builds the injected authority hook. Throws `idempotency_conflict` (409) on
 * a fingerprint mismatch and `state_unavailable` (503) when the fence is
 * missing or the authority cannot be evaluated — the caller (createTask)
 * must then refuse the protected mutation.
 */
export function createTaskCreateIdempotencyAuthority(
  getFence: () => SharedStateServingFenceV1 | undefined,
): (input: { taskId: string; canonicalRequest: string }) => TaskCreateIdempotencyDecisionV1 {
  return (input) => {
    const fence = getFence();
    if (!fence) {
      throw new BrokerError(
        "state_unavailable",
        "task_create_idempotency_state_unavailable: serving fence missing",
      );
    }
    const requestSha256Hex = createHash("sha256")
      .update(input.canonicalRequest, "utf8")
      .digest("hex");
    const outcome = fence.executeTaskCreateIdempotent(
      { taskId: input.taskId, requestSha256Hex },
      Date.now(),
    );
    if (outcome.outcome === "executed" || outcome.outcome === "replayed") {
      return { outcome: outcome.outcome };
    }
    if (outcome.outcome === "conflict") {
      throw new BrokerError(
        "idempotency_conflict",
        `task id ${input.taskId} was already created with a different payload (idempotency_conflict)`,
      );
    }
    throw new BrokerError(
      "state_unavailable",
      `task_create_idempotency_state_unavailable: ${outcome.reasonCode}`,
    );
  };
}

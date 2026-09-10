/**
 * Lease gate for #1504 §4 Slice U — the wiring layer between the worker task
 * routes and the fence-mediated V1 lease authority
 * (`claimLease`/`renewLease`/`mutateWithFence`/`releaseLease`).
 *
 * The gate is constructed only when the default-off
 * `BROKER_SHARED_STATE_V1_LEASE` flag is `on`; with the flag off the routes
 * never touch it and the legacy claim path is the whole story. It never
 * decides anything itself: every decision comes from a committed adapter
 * envelope, and every unavailable outcome becomes a retryable
 * `state_unavailable` rejection — a broker that cannot reach the lease
 * authority must not grant, renew, requeue, or complete a claim (§5.3
 * partition behavior). Authority losses (`stale_fence`, `owner_mismatch`,
 * `lease_expired`, …) become the same 409 class as a legacy claim race.
 */

import { createHash } from "node:crypto";

import { BrokerError } from "./core/broker-error.js";
import type { TaskLeaseStampV1 } from "./core/types.js";
import {
  type SharedStateLeaseMutationKindV1,
  type SharedStateLeaseReleaseKindV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";

export type SharedStateLeaseGateClaimResultV1 =
  | { readonly outcome: "claimed"; readonly stamp: TaskLeaseStampV1 }
  | { readonly outcome: "conflict"; readonly reasonCode: string }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

/**
 * The accepted authority command's updated version memory. The stamp ALWAYS
 * survives an accepted command (even a release or terminal mutation): its
 * resource version is what the next claim must present, so clearing it would
 * wedge every later claim behind a version the record can no longer name.
 */
export type SharedStateLeaseGateAuthorityResultV1 =
  | { readonly outcome: "authorized"; readonly stamp: TaskLeaseStampV1 }
  | { readonly outcome: "lost"; readonly reasonCode: string }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

export class SharedStateLeaseGateV1 {
  constructor(
    /**
     * Live fence accessor — the serving fence can be released and (on
     * restart) reacquired, so the gate resolves it per call and treats a
     * missing fence as an unavailable authority, never a local fallback.
     */
    private readonly getFence: () => SharedStateServingFenceV1 | undefined,
  ) {}

  claim(
    input: {
      readonly taskId: string;
      readonly workerId: string;
      /** Last-known resource version from the task record ("0" if none). */
      readonly expectedResourceVersion?: string;
      readonly leaseDurationMs: number;
    },
    nowMs = Date.now(),
  ): SharedStateLeaseGateClaimResultV1 {
    const fence = this.getFence();
    if (!fence) {
      return Object.freeze({ outcome: "unavailable", reasonCode: "serving_fence_missing" });
    }
    const outcome = fence.claimTaskLease(
      {
        taskId: input.taskId,
        workerId: input.workerId,
        expectedResourceVersion: input.expectedResourceVersion ?? "0",
        leaseDurationMs: input.leaseDurationMs,
      },
      nowMs,
    );
    if (outcome.outcome === "claimed") {
      return Object.freeze({
        outcome: "claimed",
        stamp: Object.freeze({
          fencingToken: outcome.fencingToken,
          attemptKeyDigest: outcome.attemptKeyDigest,
          resourceVersion: outcome.resourceVersion,
        }),
      });
    }
    if (outcome.outcome === "conflict") {
      return Object.freeze({ outcome: "conflict", reasonCode: outcome.reasonCode });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: outcome.reasonCode });
  }

  renew(
    input: {
      readonly taskId: string;
      readonly workerId: string;
      readonly stamp: TaskLeaseStampV1;
      readonly leaseDurationMs: number;
    },
    nowMs = Date.now(),
  ): SharedStateLeaseGateAuthorityResultV1 {
    const fence = this.getFence();
    if (!fence) {
      return Object.freeze({ outcome: "unavailable", reasonCode: "serving_fence_missing" });
    }
    const outcome = fence.renewTaskLease(
      {
        taskId: input.taskId,
        workerId: input.workerId,
        attemptKeyDigest: input.stamp.attemptKeyDigest,
        fencingToken: input.stamp.fencingToken,
        expectedResourceVersion: input.stamp.resourceVersion,
        leaseDurationMs: input.leaseDurationMs,
      },
      nowMs,
    );
    return authorize(outcome, input.stamp);
  }

  mutate(
    input: {
      readonly taskId: string;
      readonly workerId: string;
      readonly stamp: TaskLeaseStampV1;
      readonly mutationKind: SharedStateLeaseMutationKindV1;
      /** Raw effect content; bound into the mutation digest via sha-256. */
      readonly mutationBody: string;
    },
    nowMs = Date.now(),
  ): SharedStateLeaseGateAuthorityResultV1 {
    const fence = this.getFence();
    if (!fence) {
      return Object.freeze({ outcome: "unavailable", reasonCode: "serving_fence_missing" });
    }
    // sha-256 hex is always non-empty (the keyspace rejects empty byte
    // components), so even an empty body binds deterministically.
    const mutationBodyHex = createHash("sha256").update(input.mutationBody, "utf8").digest("hex");
    const outcome = fence.fenceTaskMutation(
      {
        taskId: input.taskId,
        workerId: input.workerId,
        attemptKeyDigest: input.stamp.attemptKeyDigest,
        fencingToken: input.stamp.fencingToken,
        expectedResourceVersion: input.stamp.resourceVersion,
        mutationKind: input.mutationKind,
        mutationBodyHex,
      },
      nowMs,
    );
    // A checkpoint keeps the claim; every other mutation kind ends it in the
    // authority — but the version memory always advances.
    return authorize(outcome, input.stamp);
  }

  release(
    input: {
      readonly taskId: string;
      readonly workerId: string;
      readonly stamp: TaskLeaseStampV1;
      readonly releaseKind: SharedStateLeaseReleaseKindV1;
    },
    nowMs = Date.now(),
  ): SharedStateLeaseGateAuthorityResultV1 {
    const fence = this.getFence();
    if (!fence) {
      return Object.freeze({ outcome: "unavailable", reasonCode: "serving_fence_missing" });
    }
    const outcome = fence.releaseTaskLease(
      {
        taskId: input.taskId,
        workerId: input.workerId,
        attemptKeyDigest: input.stamp.attemptKeyDigest,
        fencingToken: input.stamp.fencingToken,
        expectedResourceVersion: input.stamp.resourceVersion,
        releaseKind: input.releaseKind,
      },
      nowMs,
    );
    return authorize(outcome, input.stamp);
  }
}

function authorize(
  outcome:
    | { readonly outcome: "renewed" | "applied" | "released"; readonly resourceVersion: string }
    | { readonly outcome: "lost"; readonly reasonCode: string }
    | { readonly outcome: "unavailable"; readonly reasonCode: string },
  previous: TaskLeaseStampV1,
): SharedStateLeaseGateAuthorityResultV1 {
  if (outcome.outcome === "lost" || outcome.outcome === "unavailable") {
    return Object.freeze({ outcome: outcome.outcome, reasonCode: outcome.reasonCode });
  }
  // Version memory: keep the presented identity, adopt the advanced version —
  // including for releases and terminal mutations, whose versions the next
  // claim must present (§5.3: the fence never decreases).
  return Object.freeze({
    outcome: "authorized",
    stamp: Object.freeze({ ...previous, resourceVersion: outcome.resourceVersion }),
  });
}

/**
 * Throws unless the claim was granted. `conflict` maps to the same
 * `invalid_transition` 409 class as a legacy claim race; everything
 * unavailable maps to retryable `state_unavailable` (503) — never a local
 * grant (§5.3 partition behavior).
 */
export function leaseGateClaimOrThrow(
  result: SharedStateLeaseGateClaimResultV1,
  taskId: string,
): TaskLeaseStampV1 {
  if (result.outcome === "claimed") return result.stamp;
  if (result.outcome === "conflict") {
    throw new BrokerError(
      "invalid_transition",
      `task lease ${result.reasonCode}: task ${taskId} is not claimable through the lease authority`,
    );
  }
  throw new BrokerError("state_unavailable", `task_lease_state_unavailable: ${result.reasonCode}`);
}

/**
 * Throws unless the authority command was accepted. The returned stamp is the
 * updated version memory — the caller persists it immediately (before any
 * other V1 command can advance the row further).
 */
export function leaseGateAuthorityOrThrow(
  result: SharedStateLeaseGateAuthorityResultV1,
  taskId: string,
): TaskLeaseStampV1 {
  if (result.outcome === "authorized") return result.stamp;
  if (result.outcome === "lost") {
    throw new BrokerError(
      "invalid_transition",
      `task lease ${result.reasonCode}: this attempt no longer holds the lease authority for task ${taskId}`,
    );
  }
  throw new BrokerError("state_unavailable", `task_lease_state_unavailable: ${result.reasonCode}`);
}

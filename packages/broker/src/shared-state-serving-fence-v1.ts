/**
 * Serving-process fence for Phase 3 Slice K, first part.
 *
 * Decision A+A1 on #1504: reuse the V1 `shared_state_ownership` CAS as the
 * broker singleton fence for both JSON-file and SQLite persistence. This
 * module applies the V1 schema to a dedicated file, opens one adapter, and
 * releases the token on drain/close. `probe()` re-reads the ownership row
 * for `/readyz`. It does not install non-serving middleware, renew a lease,
 * or take over a live token.
 *
 * Slice S (#1504 §4 primitive integration, replay first): the fence value
 * also exposes `consumeReplayNonce`, a fail-closed passthrough of exactly one
 * V1 primitive through the fence's own single-writer adapter. The fence still
 * never initiates a command on its own; the broker calls this only when the
 * default-off `BROKER_SHARED_STATE_V1_REPLAY` flag is `on`. Every adapter
 * error, parse error, rejected envelope, or thrown exception collapses to
 * `{outcome: "unavailable"}` — never a local fallback acceptance (§5.1
 * partition behavior).
 *
 * Slice T (#1504 §4 primitive integration, rate second): same pattern for the
 * rate primitive — `reserveRateLimitCost` routes the broker-edge rate-limit
 * check through the same single-writer adapter when the default-off
 * `BROKER_SHARED_STATE_V1_RATE` flag is `on`. Every failure collapses to
 * `{outcome: "unavailable"}` — never a local permissive bucket (§5.2
 * partition behavior; V1 defines no fail-open route class).
 *
 * Slice U (#1504 §4 primitive integration, lease third): four fail-closed
 * passthroughs — `claimTaskLease`, `renewTaskLease`, `fenceTaskMutation`,
 * `releaseTaskLease` — route the task-claim lease authority through the same
 * adapter when the default-off `BROKER_SHARED_STATE_V1_LEASE` flag is `on`.
 * Every failure collapses to `unavailable` — a broker that cannot reach the
 * lease authority must not grant, renew, requeue, or complete a claim (§5.3
 * partition behavior).
 *
 * Slice V (#1504 §4 primitive integration, idempotency fourth): one fail-
 * closed passthrough — `executeTaskCreateIdempotent` — routes the §5.4.1
 * task-create authority (`broker.task.create`, `task-create-effects.v1`)
 * through the same adapter when the default-off
 * `BROKER_SHARED_STATE_V1_IDEMPOTENCY` flag is `on`. Same key with a changed
 * fingerprint is a `conflict`, never an absorbed replay; every failure
 * collapses to `unavailable` — the protected mutation must not run when the
 * authoritative record cannot be read or committed (§5.4 partition behavior).
 *
 * Slice W (#1504 §4 primitive integration, outbox fifth): one fail-closed
 * passthrough — `appendTerminalTaskEvent` — routes the task-terminal-
 * notification append/ordering authority (§5.5, namespace
 * `broker.terminal-outbox`) through the same adapter when the default-off
 * `BROKER_SHARED_STATE_V1_OUTBOX` flag is `on`. The adapter allocates the
 * per-stream sequence (callers never select one); a retry with the same
 * idempotency key and payload replays the ORIGINAL sequence; every failure
 * collapses to `unavailable` — the producing domain transaction must fail
 * when the append authority is unreachable (§5.5 partition behavior).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterErrorCodeV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  applySharedStateSqliteConnectionPragmasV1,
  applySharedStateSqliteSchemaV1,
  type SharedStateSqliteSchemaErrorCodeV1,
} from "./shared-state-sqlite-schema-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";
import {
  parseSharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-v1-values.js";

export const SHARED_STATE_SERVING_FENCE_V1 = Object.freeze({
  kind: "SharedStateServingFenceV1",
  envKey: "BROKER_SHARED_STATE_FILE",
  defaultSuffix: ".shared-state-v1.sqlite",
  isolatedTempPrefix: "a2a-serving-fence-",
  isolatedTempFileName: "shared-state-v1.sqlite",
  defaultLegacyStateFile: "/var/lib/a2a-broker/state.json",
  /** Slice S: fixed keyspace namespace for worker HTTP-signature replay. */
  replayNamespace: "security.replay.broker-worker-signature",
  /** Slice T: fixed keyspace namespace for the broker-edge rate limiter. */
  rateNamespace: "security.rate.broker-edge",
  /** Slice U: fixed keyspace namespace for the task-claim lease authority. */
  leaseNamespace: "broker.lease.task-claim",
  /** Slice V: the §5.4.1 task-create idempotency namespace and its pinned policy. */
  idempotencyNamespace: "broker.task.create",
  idempotencyRetentionPolicyVersion: "task-create-effects.v1",
  idempotencyEffectKind: "domain-mutation-with-outbox",
  /** Slice W: the §5.5 task-terminal outbox bindings, verbatim from the catalog. */
  outboxNamespace: "broker.terminal-outbox",
  outboxStreamType: "broker-terminal-outbox",
  outboxEventPurpose: "task-terminal-notification" as const,
  outboxOrderingScope: "total-within-exact-stream-key" as const,
  outboxRetentionPolicyVersion: "task-terminal-outbox-retention.v1",
  outboxReceiptPolicyVersion: "terminal-notification-receipt.v1",
  outboxAcknowledgmentPolicyVersion: "terminal-notification-ack.v1",
} as const);

/** Closed mutation kinds for `fenceTaskMutation` (Slice U, §5.3 vocabulary). */
export type SharedStateLeaseMutationKindV1 = (typeof V.leaseMutationKinds)[number];
/** Closed release kinds for `releaseTaskLease` (Slice U, §5.3 vocabulary). */
export type SharedStateLeaseReleaseKindV1 = (typeof V.leaseReleaseKinds)[number];

/**
 * Outcome of one fence-mediated `reserveRateLimitCost` (Slice T). Only a
 * committed adapter decision yields `allowed` or `rate_limited`; everything
 * else — failure codes, rejected/unavailable envelopes, released fence,
 * thrown exceptions — is `unavailable`, which the caller must map to a
 * retryable rejection, never a local permissive fallback (§5.2 partition
 * behavior).
 */
export type SharedStateFenceRateOutcomeV1 =
  | { readonly outcome: "allowed"; readonly remaining: number; readonly resetInMs: number }
  | { readonly outcome: "rate_limited"; readonly resetInMs: number }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

/**
 * Authority presentation the caller holds from a prior claim (Slice U): the
 * adapter's claim response fields, re-presented verbatim on every authority
 * command. The adapter compares fencing token first, then attempt, then
 * owner, then expiry, then version — in that order.
 */
export interface SharedStateFenceLeaseAuthorityInputV1 {
  readonly taskId: string;
  readonly workerId: string;
  readonly attemptKeyDigest: string;
  readonly fencingToken: string;
  readonly expectedResourceVersion: string;
}

/**
 * Outcome of one fence-mediated `claimLease` (Slice U). Only a committed
 * adapter decision yields `claimed`; `claim_conflict`/`version_conflict`
 * rejections are `conflict` (the caller maps them to the same 409 class as a
 * legacy claim race); everything else is `unavailable` — the claim MUST NOT
 * be granted locally (§5.3 partition behavior).
 */
export type SharedStateFenceLeaseClaimOutcomeV1 =
  | {
      readonly outcome: "claimed";
      readonly attemptKeyDigest: string;
      readonly fencingToken: string;
      readonly resourceVersion: string;
    }
  | { readonly outcome: "conflict"; readonly reasonCode: string }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

/**
 * Outcome of one fence-mediated lease authority command — `renewLease`,
 * `mutateWithFence`, or `releaseLease` (Slice U). Only committed adapter
 * decisions yield the authorized variants; the §5.3 rejection ladder
 * (`stale_fence`, `owner_mismatch`, `lease_expired`, `version_conflict`,
 * `invalid_state_transition`) is `lost` — the caller must reject the
 * mutation instead of committing locally; everything else is `unavailable`.
 */
export type SharedStateFenceLeaseAuthorityOutcomeV1 =
  | { readonly outcome: "renewed"; readonly resourceVersion: string }
  | { readonly outcome: "applied"; readonly resourceVersion: string }
  | { readonly outcome: "released"; readonly resourceVersion: string }
  | { readonly outcome: "lost"; readonly reasonCode: string }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

/**
 * Outcome of one fence-mediated `executeIdempotent` on the task-create
 * authority (Slice V). Only committed adapter decisions yield `executed` or
 * `replayed`; the same key presented with a different payload fingerprint is
 * `conflict` (§5.4: the one thing idempotency must never absorb); everything
 * else is `unavailable`.
 */
export type SharedStateFenceIdempotencyOutcomeV1 =
  | { readonly outcome: "executed"; readonly outcomeDigest: string }
  | { readonly outcome: "replayed"; readonly outcomeDigest: string }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

/**
 * Outcome of one fence-mediated `appendOutbox` on the task-terminal-
 * notification stream (Slice W). Only committed adapter decisions yield
 * `appended`/`replayed`; the stream sequence is adapter-allocated and a
 * replay always returns the ORIGINAL one (§5.5: a retry never allocates
 * again); everything else is `unavailable`.
 */
export type SharedStateFenceOutboxAppendOutcomeV1 =
  | { readonly outcome: "appended"; readonly streamSequence: string }
  | { readonly outcome: "replayed"; readonly streamSequence: string }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

/**
 * Outcome of one fence-mediated `consumeReplayNonce` (Slice S). Only a
 * committed adapter decision yields `accepted` or `replayed`; everything else
 * — failure codes, rejected/unavailable envelopes, released fence, thrown
 * exceptions — is `unavailable`, which the caller must map to a retryable
 * rejection, never a fallback accept.
 */
export type SharedStateFenceReplayOutcomeV1 =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "replayed" }
  | { readonly outcome: "unavailable"; readonly reasonCode: string };

export const SHARED_STATE_SERVING_FENCE_ERROR_CODES_V1 = Object.freeze([
  "empty_shared_state_file",
  "schema_read_failed",
  "schema_write_failed",
  "schema_version_mismatch",
  "contract_version_mismatch",
  "schema_table_missing",
  "schema_not_applied",
  "ownership_conflict",
  "adapter_unavailable",
  "clock_profile_mismatch",
  "store_failure",
  "already_open",
] as const);

export type SharedStateServingFenceErrorCodeV1 =
  (typeof SHARED_STATE_SERVING_FENCE_ERROR_CODES_V1)[number];

export type SharedStateServingFenceResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: SharedStateServingFenceErrorCodeV1 };
    };

export interface SharedStateServingFencePathInputV1 {
  readonly sharedStateFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateFile: string;
}

export const SHARED_STATE_SERVING_FENCE_PROBE_REASON_CODES_V1 = Object.freeze([
  "lost_fence",
  "adapter_unavailable",
] as const);

export type SharedStateServingFenceProbeReasonCodeV1 =
  (typeof SHARED_STATE_SERVING_FENCE_PROBE_REASON_CODES_V1)[number];

export type SharedStateServingFenceProbeV1 =
  | { readonly ready: true }
  | {
    readonly ready: false;
    readonly reasonCode: SharedStateServingFenceProbeReasonCodeV1;
  };

export interface SharedStateServingFenceV1 {
  release(): void;
  probe(): SharedStateServingFenceProbeV1;
  /**
   * Slice S fail-closed passthrough of the V1 replay primitive through the
   * fence's single-writer adapter. `input.ttlMs` must already be a positive
   * integer; the caller derives it from the signature expiry. `nowMs` is the
   * caller's observed wall instant in epoch milliseconds and is passed to the
   * adapter as the transaction's observed time (the adapter still evaluates
   * and floors it — it is never trusted blindly).
   */
  consumeReplayNonce(
    input: { readonly keyid: string; readonly nonce: string; readonly ttlMs: number },
    nowMs: number,
  ): SharedStateFenceReplayOutcomeV1;
  /**
   * Slice T fail-closed passthrough of the V1 rate primitive through the
   * fence's single-writer adapter. `input.cost`/`input.limit` must already be
   * positive integers within the V1 caps and `input.windowMs` a positive
   * duration; the caller validates its configuration at startup. `bucketClass`
   * separates the broker's general and worker limit configurations inside the
   * fixed rate namespace (they have independent limits/windows), `principal`
   * is the caller's rate-limit key string. `nowMs` is the caller's observed
   * wall instant in epoch milliseconds and is passed to the adapter as the
   * transaction's observed time (the adapter still evaluates and floors it —
   * it is never trusted blindly).
   */
  reserveRateLimitCost(
    input: {
      readonly bucketClass: "general" | "worker";
      readonly principal: string;
      readonly cost: number;
      readonly limit: number;
      readonly windowMs: number;
    },
    nowMs: number,
  ): SharedStateFenceRateOutcomeV1;
  /**
   * Slice U fail-closed passthrough of the V1 `claimLease` primitive. The
   * resource is the ("task", taskId) pair and the owner the worker id, both
   * digested under the fixed lease namespace. `expectedResourceVersion` is
   * the caller's last-known resource version ("0" before the task's first
   * V1 lease cycle). Only a committed `claimed` decision grants the claim.
   */
  claimTaskLease(
    input: {
      readonly taskId: string;
      readonly workerId: string;
      readonly expectedResourceVersion: string;
      readonly leaseDurationMs: number;
    },
    nowMs: number,
  ): SharedStateFenceLeaseClaimOutcomeV1;
  /**
   * Slice U fail-closed passthrough of `renewLease`. The caller presents the
   * stamp it holds (attempt digest, fencing token, observed resource
   * version); a superseded/expired/mismatched presentation comes back as
   * `lost`, never as a local renewal.
   */
  renewTaskLease(
    input: SharedStateFenceLeaseAuthorityInputV1 & { readonly leaseDurationMs: number },
    nowMs: number,
  ): SharedStateFenceLeaseAuthorityOutcomeV1;
  /**
   * Slice U fail-closed passthrough of `mutateWithFence`. `checkpoint` keeps
   * the claim; every other mutation kind ends it. `mutationBodyHex` is the
   * hex encoding of the content the caller binds to the mutation digest
   * (sha-256 of the raw request body — always non-empty hex).
   */
  fenceTaskMutation(
    input: SharedStateFenceLeaseAuthorityInputV1 & {
      readonly mutationKind: (typeof V.leaseMutationKinds)[number];
      readonly mutationBodyHex: string;
    },
    nowMs: number,
  ): SharedStateFenceLeaseAuthorityOutcomeV1;
  /**
   * Slice U fail-closed passthrough of `releaseLease`. Releasing a claim that
   * has already ended is reported as `released` (the cleanup goal is met),
   * never as a fabricated new authority.
   */
  releaseTaskLease(
    input: SharedStateFenceLeaseAuthorityInputV1 & {
      readonly releaseKind: (typeof V.leaseReleaseKinds)[number];
    },
    nowMs: number,
  ): SharedStateFenceLeaseAuthorityOutcomeV1;
  /**
   * Slice V fail-closed passthrough of the V1 `executeIdempotent` primitive
   * on the task-create authority. `taskId` is the caller-selected id (the
   * idempotency key); `requestSha256Hex` is the hex sha-256 of the canonical
   * normalized request (the payload fingerprint and the outbox payload
   * digest body). Deterministic, per §5.4.1's pinned retention version.
   */
  executeTaskCreateIdempotent(
    input: {
      readonly taskId: string;
      readonly requestSha256Hex: string;
    },
    nowMs: number,
  ): SharedStateFenceIdempotencyOutcomeV1;
  /**
   * Slice W fail-closed passthrough of the V1 `appendOutbox` primitive on
   * the task-terminal-notification stream. `brokerAuthorityId` is the
   * broker's stream id; `eventId` is the stable `task-id-status-completed-at`
   * event id (both the event key and the idempotency client key);
   * `payloadSha256Hex` is the hex sha-256 of the canonical event payload.
   * The adapter allocates the per-stream sequence; a retry returns the
   * original one.
   */
  appendTerminalTaskEvent(
    input: {
      readonly brokerAuthorityId: string;
      readonly eventId: string;
      readonly payloadSha256Hex: string;
    },
    nowMs: number,
  ): SharedStateFenceOutboxAppendOutcomeV1;
}

function fail(
  code: SharedStateServingFenceErrorCodeV1,
): SharedStateServingFenceResultV1<never> {
  return { ok: false, error: Object.freeze({ code }) };
}

function ownershipTokenFromRow(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (!("owner_token" in row)) return undefined;
  const token = row.owner_token;
  return typeof token === "string" ? token : undefined;
}

/**
 * Maps a committed/rejected/unavailable transaction envelope onto the
 * fail-closed fence replay outcome. Only the committed `accepted` decision is
 * an acceptance; a committed `replay` decision rejects the request, and every
 * other status or shape is `unavailable`.
 */
function fenceReplayOutcomeFromResult(
  result: SharedStateTransactionResultV1,
): SharedStateFenceReplayOutcomeV1 {
  if (result.status === V.transactionStatuses[0]) {
    const decision = (result as { result?: { decision?: unknown } }).result?.decision;
    if (decision === V.operationDecisions.consumeReplayNonce[0]) {
      return Object.freeze({ outcome: "accepted" });
    }
    if (decision === V.operationDecisions.consumeReplayNonce[1]) {
      return Object.freeze({ outcome: "replayed" });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
  }
  const reasonCode = (result as { reasonCode?: unknown }).reasonCode;
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: typeof reasonCode === "string" ? reasonCode : "store_failure",
  });
}

/**
 * Maps a committed/rejected/unavailable transaction envelope onto the
 * fail-closed fence rate outcome. Only the committed adapter decisions are
 * `allowed`/`rate_limited`; every other status or shape is `unavailable`.
 */
function fenceRateOutcomeFromResult(
  result: SharedStateTransactionResultV1,
): SharedStateFenceRateOutcomeV1 {
  if (result.status === V.transactionStatuses[0]) {
    const value = (result as {
      result?: { decision?: unknown; remaining?: unknown; resetInMs?: unknown };
    }).result;
    if (value?.decision === V.operationDecisions.reserveRateLimitCost[0]) {
      if (typeof value.remaining !== "number" || typeof value.resetInMs !== "number") {
        return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
      }
      return Object.freeze({
        outcome: "allowed",
        remaining: value.remaining,
        resetInMs: value.resetInMs,
      });
    }
    if (value?.decision === V.operationDecisions.reserveRateLimitCost[1]) {
      if (typeof value.resetInMs !== "number") {
        return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
      }
      return Object.freeze({ outcome: "rate_limited", resetInMs: value.resetInMs });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
  }
  const reasonCode = (result as { reasonCode?: unknown }).reasonCode;
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: typeof reasonCode === "string" ? reasonCode : "store_failure",
  });
}

/**
 * Slice U digest derivations under the fixed lease namespace. The resource
 * is the ("task", taskId) pair, the owner the worker id, and the mutation
 * digest binds the mutation kind to the hex-encoded effect body.
 */
function leaseResourceDigest(taskId: string) {
  return digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.lease.resource-key",
    namespace: SHARED_STATE_SERVING_FENCE_V1.leaseNamespace,
    components: [
      { field: "resourceType", type: "utf8", value: "task" },
      { field: "resourceId", type: "utf8", value: taskId },
    ],
  });
}

function leaseOwnerDigest(workerId: string) {
  return digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.lease.owner-key",
    namespace: SHARED_STATE_SERVING_FENCE_V1.leaseNamespace,
    components: [{ field: "ownerId", type: "utf8", value: workerId }],
  });
}

function leaseMutationDigest(mutationKind: string, mutationBodyHex: string) {
  return digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.lease.mutation",
    namespace: SHARED_STATE_SERVING_FENCE_V1.leaseNamespace,
    components: [
      { field: "mutationKind", type: "utf8", value: mutationKind },
      { field: "mutationBody", type: "bytes", value: mutationBodyHex },
    ],
  });
}

const CLAIM_LOST_CLASSIFICATION = new Set([
  "claim_conflict",
  "version_conflict",
]);

const AUTHORITY_LOST_CLASSIFICATION = new Set([
  "stale_fence",
  "owner_mismatch",
  "lease_expired",
  "version_conflict",
  "invalid_state_transition",
]);

/**
 * Shared transact path for the three lease authority commands (Slice U):
 * derive the resource/owner digests, build the operation-specific command
 * input (renew duration, mutation kind+digest, or release kind), present the
 * caller's authority stamp verbatim, and map the envelope fail-closed.
 */
function leaseAuthorityTransact(
  adapter: SharedStateSqliteAdapterV1,
  operation: (typeof V.operations)[number],
  authority: {
    readonly taskId: string;
    readonly workerId: string;
    readonly attemptKeyDigest: string;
    readonly fencingToken: string;
    readonly expectedResourceVersion: string;
  },
  durationMs: number,
  nowMs: number,
  extra?:
    | { readonly kind: "mutate"; readonly mutationKind: string; readonly mutationBodyHex: string }
    | { readonly kind: "release"; readonly releaseKind: string },
): SharedStateFenceLeaseAuthorityOutcomeV1 {
  const unavailable = (reasonCode: string) =>
    Object.freeze({ outcome: "unavailable", reasonCode }) as SharedStateFenceLeaseAuthorityOutcomeV1;
  const resourceDigest = leaseResourceDigest(authority.taskId);
  if (!resourceDigest.ok) return unavailable(resourceDigest.error.code);
  const ownerDigest = leaseOwnerDigest(authority.workerId);
  if (!ownerDigest.ok) return unavailable(ownerDigest.error.code);

  const base = {
    namespace: SHARED_STATE_SERVING_FENCE_V1.leaseNamespace,
    resourceKeyDigest: resourceDigest.value.digest,
    ownerKeyDigest: ownerDigest.value.digest,
    attemptKeyDigest: authority.attemptKeyDigest,
    fencingToken: authority.fencingToken,
    expectedResourceVersion: authority.expectedResourceVersion,
  };
  let input: Record<string, unknown>;
  if (extra?.kind === "mutate") {
    const mutationDigest = leaseMutationDigest(extra.mutationKind, extra.mutationBodyHex);
    if (!mutationDigest.ok) return unavailable(mutationDigest.error.code);
    input = { ...base, mutationKind: extra.mutationKind, mutationDigest: mutationDigest.value.digest };
  } else if (extra?.kind === "release") {
    input = { ...base, releaseKind: extra.releaseKind };
  } else {
    input = { ...base, leaseDurationMs: durationMs };
  }
  const command = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  if (!command.ok) return unavailable(command.error.code);
  const result = adapter.transact(command.value, {
    observedAtUnixMs: String(nowMs),
  });
  if (!result.ok) return unavailable(result.error.code);
  const expected =
    operation === V.operations[3]
      ? V.operationDecisions.renewLease[0]
      : operation === V.operations[4]
        ? V.operationDecisions.mutateWithFence[0]
        : V.operationDecisions.releaseLease[0];
  return Object.freeze(
    fenceLeaseAuthorityOutcomeFromResult(
      expected as "renewed" | "applied" | "released",
      result.value,
    ),
  );
}

function fenceLeaseClaimOutcomeFromResult(
  result: SharedStateTransactionResultV1,
): SharedStateFenceLeaseClaimOutcomeV1 {
  if (result.status === V.transactionStatuses[0]) {
    const value = (result as {
      result?: {
        decision?: unknown;
        attemptKeyDigest?: unknown;
        fencingToken?: unknown;
        resourceVersion?: unknown;
      };
    }).result;
    if (
      value?.decision === V.operationDecisions.claimLease[0]
      && typeof value.attemptKeyDigest === "string"
      && typeof value.fencingToken === "string"
      && typeof value.resourceVersion === "string"
    ) {
      return Object.freeze({
        outcome: "claimed",
        attemptKeyDigest: value.attemptKeyDigest,
        fencingToken: value.fencingToken,
        resourceVersion: value.resourceVersion,
      });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
  }
  const reasonCode = (result as { reasonCode?: unknown }).reasonCode;
  if (typeof reasonCode === "string" && CLAIM_LOST_CLASSIFICATION.has(reasonCode)) {
    return Object.freeze({ outcome: "conflict", reasonCode });
  }
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: typeof reasonCode === "string" ? reasonCode : "store_failure",
  });
}

function fenceLeaseAuthorityOutcomeFromResult(
  expected: "renewed" | "applied" | "released",
  result: SharedStateTransactionResultV1,
): SharedStateFenceLeaseAuthorityOutcomeV1 {
  if (result.status === V.transactionStatuses[0]) {
    const value = (result as {
      result?: { decision?: unknown; resourceVersion?: unknown };
    }).result;
    if (
      value?.decision === expected
      && typeof value.resourceVersion === "string"
    ) {
      return Object.freeze({
        outcome: expected,
        resourceVersion: value.resourceVersion,
      });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
  }
  const reasonCode = (result as { reasonCode?: unknown }).reasonCode;
  if (typeof reasonCode === "string" && AUTHORITY_LOST_CLASSIFICATION.has(reasonCode)) {
    return Object.freeze({ outcome: "lost", reasonCode });
  }
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: typeof reasonCode === "string" ? reasonCode : "store_failure",
  });
}

/**
 * Slice V idempotency derivations: the idempotency key, the payload
 * fingerprint, the domain-mutation digest, and the deterministic outbox link
 * digests — all under the §5.4.1 task-create namespace and its pinned
 * retention policy.
 */
function idempotencyKeyDigest(taskId: string) {
  return digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.idempotency.key",
    namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
    components: [
      { field: "operationName", type: "utf8", value: "task.create" },
      { field: "clientKey", type: "utf8", value: taskId },
    ],
  });
}

function idempotencyFingerprintDigest(requestSha256Hex: string) {
  return digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.idempotency.payload-fingerprint",
    namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
    components: [{ field: "payload", type: "bytes", value: requestSha256Hex }],
  });
}

function idempotencyDomainMutationDigest(requestSha256Hex: string) {
  return digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.idempotency.domain-mutation",
    namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
    components: [
      { field: "mutationType", type: "utf8", value: "task.create" },
      { field: "mutationBody", type: "bytes", value: requestSha256Hex },
    ],
  });
}

function isFenceErrorCode(
  code: string,
): code is SharedStateServingFenceErrorCodeV1 {
  for (const item of SHARED_STATE_SERVING_FENCE_ERROR_CODES_V1) {
    if (item === code) return true;
  }
  return false;
}

/**
 * Maps a committed/rejected/unavailable transaction envelope onto the
 * fail-closed fence outbox append outcome. Only the committed `appended` /
 * `replayed` decisions carry the adapter-allocated stream sequence; every
 * rejection or failure is `unavailable` (the producing domain transaction
 * must fail — §5.5 partition behavior).
 */
function fenceOutboxAppendOutcomeFromResult(
  result: SharedStateTransactionResultV1,
): SharedStateFenceOutboxAppendOutcomeV1 {
  if (result.status === V.transactionStatuses[0]) {
    const value = (result as {
      result?: { decision?: unknown; streamSequence?: unknown };
    }).result;
    if (
      (value?.decision === V.operationDecisions.appendOutbox[0]
        || value?.decision === V.operationDecisions.appendOutbox[1])
      && typeof value.streamSequence === "string"
    ) {
      return Object.freeze({
        outcome: value.decision as "appended" | "replayed",
        streamSequence: value.streamSequence,
      });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
  }
  const reasonCode = (result as { reasonCode?: unknown }).reasonCode;
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: typeof reasonCode === "string" ? reasonCode : "store_failure",
  });
}

/**
 * Maps a committed/rejected/unavailable transaction envelope onto the
 * fail-closed fence idempotency outcome. Only the committed `executed` /
 * `replayed` decisions carry the original outcome digest; the
 * `idempotency_conflict` rejection is a conflict; everything else is
 * `unavailable`.
 */
function fenceIdempotencyOutcomeFromResult(
  result: SharedStateTransactionResultV1,
): SharedStateFenceIdempotencyOutcomeV1 {
  if (result.status === V.transactionStatuses[0]) {
    const value = (result as {
      result?: { decision?: unknown; outcomeDigest?: unknown };
    }).result;
    if (
      (value?.decision === V.operationDecisions.executeIdempotent[0]
        || value?.decision === V.operationDecisions.executeIdempotent[1])
      && typeof value.outcomeDigest === "string"
    ) {
      return Object.freeze({
        outcome: value.decision as "executed" | "replayed",
        outcomeDigest: value.outcomeDigest,
      });
    }
    return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
  }
  if (
    (result as { reasonCode?: unknown }).reasonCode
      === V.operationRejectionReasonCodes.executeIdempotent[0]
  ) {
    return Object.freeze({ outcome: "conflict" });
  }
  const reasonCode = (result as { reasonCode?: unknown }).reasonCode;
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: typeof reasonCode === "string" ? reasonCode : "store_failure",
  });
}

export function isolatedSharedStateServingFencePathV1(): string {
  return join(
    mkdtempSync(
      join(tmpdir(), SHARED_STATE_SERVING_FENCE_V1.isolatedTempPrefix),
    ),
    SHARED_STATE_SERVING_FENCE_V1.isolatedTempFileName,
  );
}

/**
 * Resolves the dedicated V1 fence file. A present empty string is a
 * misconfiguration, not an omitted default.
 */
export function resolveSharedStateServingFencePathV1(
  input: SharedStateServingFencePathInputV1,
): SharedStateServingFenceResultV1<string> {
  if (input.sharedStateFile !== undefined) {
    if (input.sharedStateFile === "") return fail("empty_shared_state_file");
    return { ok: true, value: input.sharedStateFile };
  }
  const env = input.env ?? process.env;
  if (Object.hasOwn(env, SHARED_STATE_SERVING_FENCE_V1.envKey)) {
    const raw = env[SHARED_STATE_SERVING_FENCE_V1.envKey];
    if (raw === undefined || raw === "") return fail("empty_shared_state_file");
    return { ok: true, value: raw };
  }
  return {
    ok: true,
    value: `${input.stateFile}${SHARED_STATE_SERVING_FENCE_V1.defaultSuffix}`,
  };
}

function mapSchemaCode(
  code: SharedStateSqliteSchemaErrorCodeV1,
): SharedStateServingFenceErrorCodeV1 {
  return isFenceErrorCode(code) ? code : "adapter_unavailable";
}

function mapAdapterCode(
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateServingFenceErrorCodeV1 {
  return isFenceErrorCode(code) ? code : "adapter_unavailable";
}

/**
 * Applies the V1 schema if needed and acquires exclusive ownership. The
 * caller must `release()` so a later process can acquire after a clean
 * shutdown. Crash without release leaves the token set (decision A1).
 */
export function openSharedStateServingFenceV1(input: {
  readonly filePath: string;
  readonly ownerToken?: string;
}): SharedStateServingFenceResultV1<SharedStateServingFenceV1> {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(input.filePath, { timeout: 0 });
  } catch {
    return fail("adapter_unavailable");
  }

  // #2081: WAL so the request-path ownership probe never blocks behind a
  // writer; NORMAL is the standard probe-connection pairing.
  applySharedStateSqliteConnectionPragmasV1(db, { durability: "probe" });

  const applied = applySharedStateSqliteSchemaV1(db);
  if (!applied.ok) {
    db.close();
    return fail(mapSchemaCode(applied.error.code));
  }

  const ownerToken = input.ownerToken ?? randomUUID();
  const adapter = new SharedStateSqliteAdapterV1({
    db,
    ownerToken,
    backwardSkewToleranceMs: "0",
  });
  const opened = adapter.open();
  if (!opened.ok) {
    db.close();
    return fail(mapAdapterCode(opened.error.code));
  }

  let released = false;
  // The probe runs on every request the server fences, so compile its
  // statement once; lazily inside the try so a prepare failure still reads
  // as adapter_unavailable.
  let probeStatement: StatementSync | undefined;
  return {
    ok: true,
    value: Object.freeze({
      release(): void {
        if (released) return;
        released = true;
        adapter.drain();
        adapter.close();
        db.close();
      },
      probe(): SharedStateServingFenceProbeV1 {
        if (released) {
          return Object.freeze({ ready: false, reasonCode: "adapter_unavailable" });
        }
        try {
          probeStatement ??= db.prepare(
            `SELECT owner_token FROM shared_state_ownership WHERE id = ?`,
          );
          const row: unknown = probeStatement.get(SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
          const token = ownershipTokenFromRow(row);
          if (token === undefined) {
            return Object.freeze({
              ready: false,
              reasonCode: "adapter_unavailable",
            });
          }
          if (token !== ownerToken) {
            return Object.freeze({ ready: false, reasonCode: "lost_fence" });
          }
          return Object.freeze({ ready: true });
        } catch {
          return Object.freeze({
            ready: false,
            reasonCode: "adapter_unavailable",
          });
        }
      },
      consumeReplayNonce(
        input: { readonly keyid: string; readonly nonce: string; readonly ttlMs: number },
        nowMs: number,
      ): SharedStateFenceReplayOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          const keyDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "security.replay.requester-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.replayNamespace,
            components: [{ field: "requesterId", type: "utf8", value: input.keyid }],
          });
          if (!keyDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: keyDigest.error.code });
          }
          const nonceDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "security.replay.nonce",
            namespace: SHARED_STATE_SERVING_FENCE_V1.replayNamespace,
            components: [{ field: "nonce", type: "utf8", value: input.nonce }],
          });
          if (!nonceDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: nonceDigest.error.code });
          }
          const command = parseSharedStateTransactionCommandV1({
            kind: V.kinds.transactionCommand,
            contractVersion: V.versions.contract,
            transactionVersion: V.versions.transaction,
            operationVersion: V.versions.operation,
            operation: V.operations[0],
            input: {
              namespace: SHARED_STATE_SERVING_FENCE_V1.replayNamespace,
              keyDigest: keyDigest.value.digest,
              nonceDigest: nonceDigest.value.digest,
              ttlMs: input.ttlMs,
            },
          });
          if (!command.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: command.error.code });
          }
          const result = adapter.transact(command.value, {
            observedAtUnixMs: String(nowMs),
          });
          if (!result.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: result.error.code });
          }
          return Object.freeze(fenceReplayOutcomeFromResult(result.value));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      reserveRateLimitCost(
        input: {
          readonly bucketClass: "general" | "worker";
          readonly principal: string;
          readonly cost: number;
          readonly limit: number;
          readonly windowMs: number;
        },
        nowMs: number,
      ): SharedStateFenceRateOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          const bucketKeyDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "security.rate-limit.bucket-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.rateNamespace,
            components: [
              { field: "principal", type: "utf8", value: input.principal },
              { field: "route", type: "utf8", value: input.bucketClass },
            ],
          });
          if (!bucketKeyDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: bucketKeyDigest.error.code });
          }
          const command = parseSharedStateTransactionCommandV1({
            kind: V.kinds.transactionCommand,
            contractVersion: V.versions.contract,
            transactionVersion: V.versions.transaction,
            operationVersion: V.versions.operation,
            operation: V.operations[1],
            input: {
              namespace: SHARED_STATE_SERVING_FENCE_V1.rateNamespace,
              bucketKeyDigest: bucketKeyDigest.value.digest,
              cost: input.cost,
              limit: input.limit,
              windowMs: input.windowMs,
            },
          });
          if (!command.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: command.error.code });
          }
          const result = adapter.transact(command.value, {
            observedAtUnixMs: String(nowMs),
          });
          if (!result.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: result.error.code });
          }
          return Object.freeze(fenceRateOutcomeFromResult(result.value));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      claimTaskLease(
        input: {
          readonly taskId: string;
          readonly workerId: string;
          readonly expectedResourceVersion: string;
          readonly leaseDurationMs: number;
        },
        nowMs: number,
      ): SharedStateFenceLeaseClaimOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          const resourceDigest = leaseResourceDigest(input.taskId);
          if (!resourceDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: resourceDigest.error.code });
          }
          const ownerDigest = leaseOwnerDigest(input.workerId);
          if (!ownerDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: ownerDigest.error.code });
          }
          const command = parseSharedStateTransactionCommandV1({
            kind: V.kinds.transactionCommand,
            contractVersion: V.versions.contract,
            transactionVersion: V.versions.transaction,
            operationVersion: V.versions.operation,
            operation: V.operations[2],
            input: {
              namespace: SHARED_STATE_SERVING_FENCE_V1.leaseNamespace,
              resourceKeyDigest: resourceDigest.value.digest,
              ownerKeyDigest: ownerDigest.value.digest,
              leaseDurationMs: input.leaseDurationMs,
              expectedResourceVersion: input.expectedResourceVersion,
            },
          });
          if (!command.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: command.error.code });
          }
          const result = adapter.transact(command.value, {
            observedAtUnixMs: String(nowMs),
          });
          if (!result.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: result.error.code });
          }
          return Object.freeze(fenceLeaseClaimOutcomeFromResult(result.value));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      renewTaskLease(
        input: SharedStateFenceLeaseAuthorityInputV1 & { readonly leaseDurationMs: number },
        nowMs: number,
      ): SharedStateFenceLeaseAuthorityOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          return Object.freeze(leaseAuthorityTransact(
            adapter,
            V.operations[3],
            {
              taskId: input.taskId,
              workerId: input.workerId,
              attemptKeyDigest: input.attemptKeyDigest,
              fencingToken: input.fencingToken,
              expectedResourceVersion: input.expectedResourceVersion,
            },
            input.leaseDurationMs,
            nowMs,
          ));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      fenceTaskMutation(
        input: SharedStateFenceLeaseAuthorityInputV1 & {
          readonly mutationKind: (typeof V.leaseMutationKinds)[number];
          readonly mutationBodyHex: string;
        },
        nowMs: number,
      ): SharedStateFenceLeaseAuthorityOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          return Object.freeze(leaseAuthorityTransact(
            adapter,
            V.operations[4],
            {
              taskId: input.taskId,
              workerId: input.workerId,
              attemptKeyDigest: input.attemptKeyDigest,
              fencingToken: input.fencingToken,
              expectedResourceVersion: input.expectedResourceVersion,
            },
            0,
            nowMs,
            {
              kind: "mutate",
              mutationKind: input.mutationKind,
              mutationBodyHex: input.mutationBodyHex,
            },
          ));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      releaseTaskLease(
        input: SharedStateFenceLeaseAuthorityInputV1 & {
          readonly releaseKind: (typeof V.leaseReleaseKinds)[number];
        },
        nowMs: number,
      ): SharedStateFenceLeaseAuthorityOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          return Object.freeze(leaseAuthorityTransact(
            adapter,
            V.operations[5],
            {
              taskId: input.taskId,
              workerId: input.workerId,
              attemptKeyDigest: input.attemptKeyDigest,
              fencingToken: input.fencingToken,
              expectedResourceVersion: input.expectedResourceVersion,
            },
            0,
            nowMs,
            { kind: "release", releaseKind: input.releaseKind },
          ));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      executeTaskCreateIdempotent(
        input: {
          readonly taskId: string;
          readonly requestSha256Hex: string;
        },
        nowMs: number,
      ): SharedStateFenceIdempotencyOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          const keyDigest = idempotencyKeyDigest(input.taskId);
          if (!keyDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: keyDigest.error.code });
          }
          const fingerprint = idempotencyFingerprintDigest(input.requestSha256Hex);
          if (!fingerprint.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: fingerprint.error.code });
          }
          const domainMutation = idempotencyDomainMutationDigest(input.requestSha256Hex);
          if (!domainMutation.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: domainMutation.error.code });
          }
          const streamKey = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.stream-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
            components: [
              { field: "streamType", type: "utf8", value: "task" },
              { field: "streamId", type: "utf8", value: input.taskId },
            ],
          });
          if (!streamKey.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: streamKey.error.code });
          }
          const eventKey = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.event-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
            components: [
              { field: "eventId", type: "utf8", value: `created:${input.taskId}` },
            ],
          });
          if (!eventKey.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: eventKey.error.code });
          }
          const payloadDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.payload",
            namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
            components: [{ field: "payload", type: "bytes", value: input.requestSha256Hex }],
          });
          if (!payloadDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: payloadDigest.error.code });
          }
          const command = parseSharedStateTransactionCommandV1({
            kind: V.kinds.transactionCommand,
            contractVersion: V.versions.contract,
            transactionVersion: V.versions.transaction,
            operationVersion: V.versions.operation,
            operation: V.operations[6],
            input: {
              namespace: SHARED_STATE_SERVING_FENCE_V1.idempotencyNamespace,
              keyDigest: keyDigest.value.digest,
              payloadFingerprint: fingerprint.value.digest,
              retentionPolicyVersion:
                SHARED_STATE_SERVING_FENCE_V1.idempotencyRetentionPolicyVersion,
              effect: {
                kind: SHARED_STATE_SERVING_FENCE_V1.idempotencyEffectKind,
                domainMutationDigest: domainMutation.value.digest,
                outbox: {
                  streamKeyDigest: streamKey.value.digest,
                  eventKeyDigest: eventKey.value.digest,
                  payloadDigest: payloadDigest.value.digest,
                  retentionPolicyVersion:
                    SHARED_STATE_SERVING_FENCE_V1.idempotencyRetentionPolicyVersion,
                },
              },
            },
          });
          if (!command.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: command.error.code });
          }
          const result = adapter.transact(command.value, {
            observedAtUnixMs: String(nowMs),
          });
          if (!result.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: result.error.code });
          }
          return Object.freeze(fenceIdempotencyOutcomeFromResult(result.value));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
      appendTerminalTaskEvent(
        input: {
          readonly brokerAuthorityId: string;
          readonly eventId: string;
          readonly payloadSha256Hex: string;
        },
        nowMs: number,
      ): SharedStateFenceOutboxAppendOutcomeV1 {
        if (released) {
          return Object.freeze({ outcome: "unavailable", reasonCode: "adapter_unavailable" });
        }
        try {
          const streamKeyDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.stream-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.outboxNamespace,
            components: [
              { field: "streamType", type: "utf8", value: SHARED_STATE_SERVING_FENCE_V1.outboxStreamType },
              { field: "streamId", type: "utf8", value: input.brokerAuthorityId },
            ],
          });
          if (!streamKeyDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: streamKeyDigest.error.code });
          }
          const idempotencyKeyDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.idempotency-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.outboxNamespace,
            components: [
              { field: "producerId", type: "utf8", value: SHARED_STATE_SERVING_FENCE_V1.outboxStreamType },
              { field: "clientKey", type: "utf8", value: input.eventId },
            ],
          });
          if (!idempotencyKeyDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: idempotencyKeyDigest.error.code });
          }
          const eventKeyDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.event-key",
            namespace: SHARED_STATE_SERVING_FENCE_V1.outboxNamespace,
            components: [{ field: "eventId", type: "utf8", value: input.eventId }],
          });
          if (!eventKeyDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: eventKeyDigest.error.code });
          }
          const payloadDigest = digestSharedStateKeyV1({
            keyspaceVersion: V.versions.keyspace,
            domain: "broker.outbox.payload",
            namespace: SHARED_STATE_SERVING_FENCE_V1.outboxNamespace,
            components: [{ field: "payload", type: "bytes", value: input.payloadSha256Hex }],
          });
          if (!payloadDigest.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: payloadDigest.error.code });
          }
          const command = parseSharedStateTransactionCommandV1({
            kind: V.kinds.transactionCommand,
            contractVersion: V.versions.contract,
            transactionVersion: V.versions.transaction,
            operationVersion: V.versions.operation,
            operation: V.operations[7],
            input: {
              namespace: SHARED_STATE_SERVING_FENCE_V1.outboxNamespace,
              eventPurpose: SHARED_STATE_SERVING_FENCE_V1.outboxEventPurpose,
              streamKey: {
                keyspaceVersion: V.versions.keyspace,
                components: [
                  { field: "streamType", type: "utf8", value: SHARED_STATE_SERVING_FENCE_V1.outboxStreamType },
                  { field: "streamId", type: "utf8", value: input.brokerAuthorityId },
                ],
              },
              streamKeyDigest: streamKeyDigest.value.digest,
              orderingScope: SHARED_STATE_SERVING_FENCE_V1.outboxOrderingScope,
              idempotencyKeyDigest: idempotencyKeyDigest.value.digest,
              eventKeyDigest: eventKeyDigest.value.digest,
              payloadDigest: payloadDigest.value.digest,
              retentionPolicyVersion:
                SHARED_STATE_SERVING_FENCE_V1.outboxRetentionPolicyVersion,
              receiptPolicyVersion:
                SHARED_STATE_SERVING_FENCE_V1.outboxReceiptPolicyVersion,
              acknowledgmentPolicyVersion:
                SHARED_STATE_SERVING_FENCE_V1.outboxAcknowledgmentPolicyVersion,
            },
          });
          if (!command.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: command.error.code });
          }
          const result = adapter.transact(command.value, {
            observedAtUnixMs: String(nowMs),
          });
          if (!result.ok) {
            return Object.freeze({ outcome: "unavailable", reasonCode: result.error.code });
          }
          return Object.freeze(fenceOutboxAppendOutcomeFromResult(result.value));
        } catch {
          return Object.freeze({ outcome: "unavailable", reasonCode: "store_failure" });
        }
      },
    }),
  };
}

export function assertSharedStateServingFenceV1(input: {
  readonly filePath: string;
}): SharedStateServingFenceV1 {
  const fence = openSharedStateServingFenceV1({ filePath: input.filePath });
  if (!fence.ok) {
    throw new Error(
      `shared-state serving fence rejected: ${fence.error.code}`,
    );
  }
  return fence.value;
}

/**
 * Broker construction entry. An injected `stateStore` is not the
 * `STATE_FILE` identity, so it gets an isolated temp fence unless the
 * operator or test set the path explicitly.
 */
export function acquireSharedStateServingFenceForBrokerV1(input: {
  readonly sharedStateFile?: string;
  readonly stateFile: string;
  readonly injectedStore: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Which `stateFile` counts as "the unconfigured default" for the
   * missing-directory isolation branch below. Defaults to the production
   * constant; injectable so tests can exercise that branch against a path that
   * is genuinely absent instead of the host's live `/var/lib/a2a-broker`, which
   * on any broker-running node is owned by another process and turns the test
   * into an unconditional `ownership_conflict` (#2051 item 5).
   */
  readonly defaultLegacyStateFile?: string;
}): SharedStateServingFenceV1 {
  const env = input.env ?? process.env;
  const explicit =
    input.sharedStateFile !== undefined
    || Object.hasOwn(env, SHARED_STATE_SERVING_FENCE_V1.envKey);
  if (!explicit && input.injectedStore) {
    return assertSharedStateServingFenceV1({
      filePath: isolatedSharedStateServingFencePathV1(),
    });
  }
  const path = resolveSharedStateServingFencePathV1({
    ...(input.sharedStateFile === undefined
      ? {}
      : { sharedStateFile: input.sharedStateFile }),
    stateFile: input.stateFile,
    env,
  });
  if (!path.ok) {
    throw new Error(
      `shared-state serving fence rejected: ${path.error.code}`,
    );
  }
  const directory = dirname(path.value);
  if (!existsSync(directory)) {
    const defaultLegacy =
      input.stateFile ===
      (input.defaultLegacyStateFile ?? SHARED_STATE_SERVING_FENCE_V1.defaultLegacyStateFile);
    if (!explicit && defaultLegacy) {
      return assertSharedStateServingFenceV1({
        filePath: isolatedSharedStateServingFencePathV1(),
      });
    }
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      throw new Error(
        "shared-state serving fence rejected: adapter_unavailable",
      );
    }
  }
  return assertSharedStateServingFenceV1({ filePath: path.value });
}

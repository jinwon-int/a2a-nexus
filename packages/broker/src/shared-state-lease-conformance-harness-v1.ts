/**
 * Backend-neutral deterministic lease/claim conformance harness for
 * `a2a.shared-state.storage/v1`.
 *
 * The harness consumes the existing closed transaction and lifecycle
 * envelopes. It does not implement storage, select a backend, or attach to
 * broker runtime. Targets provide bounded test controls for an injected clock,
 * transaction fault points, singleton lifecycle, and a public-safe snapshot.
 */

import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_LEASE_CONFORMANCE_V1 = Object.freeze({
  kind: "SharedStateLeaseConformanceReportV1",
  harnessVersion: 1,
  scope: "lease-claim",
  contenderCount: 32,
  schedulerSeed: 1504,
  leaseDurationMs: 64,
  transactionLimit: 64,
  expectedTransactionCount: 48,
} as const);

export const SHARED_STATE_LEASE_FAULT_POINTS_V1 = Object.freeze([
  "before_mutation",
  "after_resource_mutation",
  "after_audit_outbox_staging",
  "before_commit",
] as const);

export const SHARED_STATE_LEASE_CONFORMANCE_ERROR_CODES_V1 = Object.freeze([
  "invalid_generated_command",
  "invalid_target_result",
  "invalid_target_lifecycle",
  "invalid_target_snapshot",
  "target_operation_failed",
  "target_lifecycle_failed",
  "target_snapshot_failed",
  "target_fault_control_failed",
  "barrier_not_ready",
  "operation_limit_exceeded",
  "claim_outcome_mismatch",
  "attempt_binding_mismatch",
  "fence_not_monotonic",
  "stale_fence_mismatch",
  "state_changed_on_rejection",
  "transaction_not_atomic",
  "reopen_snapshot_mismatch",
  "singleton_not_exclusive",
  "report_invalid",
  "reference_model_invariant",
] as const);

export type SharedStateLeaseFaultPointV1 =
  (typeof SHARED_STATE_LEASE_FAULT_POINTS_V1)[number];
export type SharedStateLeaseConformanceErrorCodeV1 =
  (typeof SHARED_STATE_LEASE_CONFORMANCE_ERROR_CODES_V1)[number];
export type SharedStateLeaseOperationV1 =
  | "claimLease"
  | "renewLease"
  | "mutateWithFence"
  | "releaseLease";
export type SharedStateLeaseTransactionCommandV1 = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: SharedStateLeaseOperationV1 }
>;
export type SharedStateLeaseTransactionResultV1 = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: SharedStateLeaseOperationV1 }
>;

type LeaseCommandForV1<Operation extends SharedStateLeaseOperationV1> =
  Extract<SharedStateLeaseTransactionCommandV1, { readonly operation: Operation }>;
type LeaseResultForV1<Operation extends SharedStateLeaseOperationV1> =
  Extract<SharedStateLeaseTransactionResultV1, { readonly operation: Operation }>;

export class SharedStateLeaseConformanceErrorV1 extends Error {
  readonly code: SharedStateLeaseConformanceErrorCodeV1;

  constructor(code: SharedStateLeaseConformanceErrorCodeV1) {
    super(code);
    this.name = "SharedStateLeaseConformanceErrorV1";
    this.code = code;
    this.stack = `${this.name}: ${code}`;
  }
}

function fail(
  code: SharedStateLeaseConformanceErrorCodeV1,
): never {
  throw new SharedStateLeaseConformanceErrorV1(code);
}

const decimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/);
const boundedCountSchema = z.number().int().nonnegative().max(
  SHARED_STATE_LEASE_CONFORMANCE_V1.transactionLimit,
);

export const sharedStateLeaseConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal("SharedStateLeaseConformanceSnapshotV1"),
    snapshotVersion: z.literal(1),
    resourceBinding: z.enum(["unbound", "bound"]),
    resourceState: z.enum(["queued", "claimed"]),
    resourceVersion: decimalSchema,
    maximumFencingToken: decimalSchema,
    activeClaim: z.boolean(),
    attemptCount: boundedCountSchema,
    mutationCount: boundedCountSchema,
    auditCount: boundedCountSchema,
    outboxCount: boundedCountSchema,
  })
  .strict();

export type SharedStateLeaseConformanceSnapshotV1 = Readonly<
  z.infer<typeof sharedStateLeaseConformanceSnapshotV1Schema>
>;

const faultReportSchema = z
  .object({
    faultPoint: z.enum(SHARED_STATE_LEASE_FAULT_POINTS_V1),
    failedReasonCode: z.literal("authority_unavailable"),
    rollback: z.literal("all-or-none"),
    nextCleanClaim: z.literal("committed"),
  })
  .strict();

export const sharedStateLeaseConformanceReportV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_LEASE_CONFORMANCE_V1.kind),
    harnessVersion: z.literal(
      SHARED_STATE_LEASE_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    scope: z.literal(SHARED_STATE_LEASE_CONFORMANCE_V1.scope),
    status: z.literal("passed"),
    scheduler: z
      .object({
        kind: z.literal("seeded-deterministic"),
        seed: z.literal(SHARED_STATE_LEASE_CONFORMANCE_V1.schedulerSeed),
        contenderCount: z.literal(
          SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount,
        ),
        barrier: z.literal("explicit-promise"),
        transactionLimit: z.literal(
          SHARED_STATE_LEASE_CONFORMANCE_V1.transactionLimit,
        ),
        transactionCount: z.literal(
          SHARED_STATE_LEASE_CONFORMANCE_V1.expectedTransactionCount,
        ),
      })
      .strict(),
    claims: z
      .object({
        committedAtBarrier: z.literal(1),
        deterministicConflictsAtBarrier: z.literal(31),
        conflictReasonCode: z.literal("claim_conflict"),
        winnerSeededRank: z.literal(1),
        winnerAttemptCount: z.literal(1),
        winnerAuthorityCheck: z.literal("renewed"),
        successfulClaimFencingTokens: z
          .array(z.string().regex(/^[1-9][0-9]{0,39}$/))
          .length(3),
        laterFencesStrictlyGreater: z.literal(true),
      })
      .strict(),
    expiry: z
      .object({
        clock: z.literal("injected-fake"),
        advance: z.literal("exactly-through-expiry"),
        reclaim: z.literal("committed"),
      })
      .strict(),
    staleFence: z
      .object({
        reasonCode: z.literal("stale_fence"),
        renewRejections: z.literal(1),
        completeMutationRejections: z.literal(1),
        checkpointMutationRejections: z.literal(1),
        releaseRejections: z.literal(1),
        stateUnchanged: z.literal(true),
      })
      .strict(),
    transactionFaults: z
      .array(faultReportSchema)
      .length(SHARED_STATE_LEASE_FAULT_POINTS_V1.length),
    closeReopen: z
      .object({
        snapshot: z.literal("preserved"),
        laterFence: z.literal("strictly-greater"),
      })
      .strict(),
    singleton: z
      .object({
        secondSimultaneousOwner: z.literal("failed-closed"),
        reasonCode: z.literal("ownership_conflict"),
      })
      .strict(),
  })
  .strict();

export type SharedStateLeaseConformanceReportV1 = Readonly<
  z.infer<typeof sharedStateLeaseConformanceReportV1Schema>
>;

export interface SharedStateLeaseConformanceClockV1 {
  readLogicalMilliseconds(): bigint;
}

export interface SharedStateLeaseConformanceClockControlV1
  extends SharedStateLeaseConformanceClockV1 {
  advanceExactlyBy(milliseconds: number): void;
}

export class InjectedDeterministicFakeClockV1
implements SharedStateLeaseConformanceClockControlV1 {
  #logicalMilliseconds = 0n;

  readLogicalMilliseconds(): bigint {
    return this.#logicalMilliseconds;
  }

  advanceExactlyBy(milliseconds: number): void {
    if (
      !Number.isSafeInteger(milliseconds)
      || milliseconds < 0
      || milliseconds > V.limits.maxDurationMs
    ) {
      fail("target_operation_failed");
    }
    this.#logicalMilliseconds += BigInt(milliseconds);
  }
}

export type SharedStateLeaseConformanceOwnerSlotV1 =
  | "primary"
  | "secondary";

/**
 * Backend-neutral target seam. Implementations expose only contract envelopes
 * and bounded, public-safe test controls; no backend command or caller clock
 * enters a transaction command.
 */
export interface SharedStateLeaseConformanceTargetV1 {
  openSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown>;
  transact(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
    command: SharedStateLeaseTransactionCommandV1,
  ): Promise<unknown>;
  snapshot(): Promise<unknown>;
  armTransactionFault(faultPoint: SharedStateLeaseFaultPointV1): void;
  closeSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown>;
}

export interface SharedStateLeaseConformanceTargetFactoryV1 {
  create(input: {
    readonly clock: SharedStateLeaseConformanceClockV1;
  }): Promise<SharedStateLeaseConformanceTargetV1>;
}

export class ExplicitPromiseBarrierV1 {
  readonly #expected: number;
  #arrived = 0;
  #released = false;
  readonly #allArrived: Promise<void>;
  readonly #gate: Promise<void>;
  #resolveAllArrived!: () => void;
  #resolveGate!: () => void;

  constructor(expected: number) {
    if (
      !Number.isSafeInteger(expected)
      || expected <= 0
      || expected > SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount
    ) {
      fail("barrier_not_ready");
    }
    this.#expected = expected;
    this.#allArrived = new Promise((resolve) => {
      this.#resolveAllArrived = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#resolveGate = resolve;
    });
  }

  async arriveAndWait(): Promise<void> {
    if (this.#released || this.#arrived >= this.#expected) {
      fail("barrier_not_ready");
    }
    this.#arrived += 1;
    if (this.#arrived === this.#expected) this.#resolveAllArrived();
    await this.#gate;
  }

  async waitUntilAllArrived(): Promise<void> {
    await this.#allArrived;
  }

  release(): void {
    if (this.#released || this.#arrived !== this.#expected) {
      fail("barrier_not_ready");
    }
    this.#released = true;
    this.#resolveGate();
  }
}

export function seededDeterministicContenderOrderV1(): readonly number[] {
  const order = Array.from(
    { length: SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount },
    (_, index) => index,
  );
  let state = SHARED_STATE_LEASE_CONFORMANCE_V1.schedulerSeed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (
      Math.imul(state, 1_664_525) + 1_013_904_223
    ) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function sameSnapshot(
  left: SharedStateLeaseConformanceSnapshotV1,
  right: SharedStateLeaseConformanceSnapshotV1,
): boolean {
  return (
    left.kind === right.kind
    && left.snapshotVersion === right.snapshotVersion
    && left.resourceBinding === right.resourceBinding
    && left.resourceState === right.resourceState
    && left.resourceVersion === right.resourceVersion
    && left.maximumFencingToken === right.maximumFencingToken
    && left.activeClaim === right.activeClaim
    && left.attemptCount === right.attemptCount
    && left.mutationCount === right.mutationCount
    && left.auditCount === right.auditCount
    && left.outboxCount === right.outboxCount
  );
}

function digest(
  domain:
    | "broker.lease.resource-key"
    | "broker.lease.owner-key"
    | "broker.lease.mutation",
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "bytes";
    readonly value: string;
  }[],
): string {
  const result = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: "broker.lease.conformance",
    components,
  });
  if (!result.ok) fail("invalid_generated_command");
  return result.value.digest;
}

const RESOURCE_KEY_DIGEST = digest("broker.lease.resource-key", [
  { field: "resourceType", type: "utf8", value: "synthetic-lease" },
  { field: "resourceId", type: "utf8", value: "single-resource" },
]);

function ownerKeyDigest(index: number): string {
  return digest("broker.lease.owner-key", [
    { field: "ownerId", type: "utf8", value: `synthetic-${index}` },
  ]);
}

const MUTATION_DIGESTS = Object.freeze({
  complete: digest("broker.lease.mutation", [
    { field: "mutationKind", type: "utf8", value: "complete" },
    { field: "mutationBody", type: "bytes", value: "aa" },
  ]),
  checkpoint: digest("broker.lease.mutation", [
    { field: "mutationKind", type: "utf8", value: "checkpoint" },
    { field: "mutationBody", type: "bytes", value: "bb" },
  ]),
});

function commandFor<Operation extends SharedStateLeaseOperationV1>(
  operation: Operation,
  input: LeaseCommandForV1<Operation>["input"],
): LeaseCommandForV1<Operation> {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  if (!parsed.ok || parsed.value.operation !== operation) {
    fail("invalid_generated_command");
  }
  return parsed.value as LeaseCommandForV1<Operation>;
}

function claimCommand(
  ownerIndex: number,
  expectedResourceVersion: string,
): LeaseCommandForV1<"claimLease"> {
  return commandFor("claimLease", {
    namespace: "broker.lease.conformance",
    resourceKeyDigest: RESOURCE_KEY_DIGEST,
    ownerKeyDigest: ownerKeyDigest(ownerIndex),
    leaseDurationMs: SHARED_STATE_LEASE_CONFORMANCE_V1.leaseDurationMs,
    expectedResourceVersion,
  });
}

function renewCommand(
  claim: LeaseCommandForV1<"claimLease">,
  claimResult: Extract<
    LeaseResultForV1<"claimLease">,
    { readonly status: "committed" }
  >,
): LeaseCommandForV1<"renewLease"> {
  return commandFor("renewLease", {
    namespace: claim.input.namespace,
    resourceKeyDigest: claim.input.resourceKeyDigest,
    ownerKeyDigest: claim.input.ownerKeyDigest,
    attemptKeyDigest: claimResult.result.attemptKeyDigest,
    fencingToken: claimResult.result.fencingToken,
    expectedResourceVersion: claimResult.result.resourceVersion,
    leaseDurationMs: SHARED_STATE_LEASE_CONFORMANCE_V1.leaseDurationMs,
  });
}

function staleCommands(
  claim: LeaseCommandForV1<"claimLease">,
  claimResult: Extract<
    LeaseResultForV1<"claimLease">,
    { readonly status: "committed" }
  >,
  expectedResourceVersion: string,
): readonly SharedStateLeaseTransactionCommandV1[] {
  const authority = {
    namespace: claim.input.namespace,
    resourceKeyDigest: claim.input.resourceKeyDigest,
    ownerKeyDigest: claim.input.ownerKeyDigest,
    attemptKeyDigest: claimResult.result.attemptKeyDigest,
    fencingToken: claimResult.result.fencingToken,
    expectedResourceVersion,
  };
  return Object.freeze([
    commandFor("renewLease", {
      ...authority,
      leaseDurationMs: SHARED_STATE_LEASE_CONFORMANCE_V1.leaseDurationMs,
    }),
    commandFor("mutateWithFence", {
      ...authority,
      mutationKind: "complete",
      mutationDigest: MUTATION_DIGESTS.complete,
    }),
    commandFor("mutateWithFence", {
      ...authority,
      mutationKind: "checkpoint",
      mutationDigest: MUTATION_DIGESTS.checkpoint,
    }),
    commandFor("releaseLease", {
      ...authority,
      releaseKind: "release",
    }),
  ]);
}

async function createTarget(
  factory: SharedStateLeaseConformanceTargetFactoryV1,
  clock: SharedStateLeaseConformanceClockV1,
): Promise<SharedStateLeaseConformanceTargetV1> {
  try {
    return await factory.create({ clock });
  } catch {
    return fail("target_lifecycle_failed");
  }
}

async function lifecycle(
  action: () => Promise<unknown>,
): Promise<SharedStateStorageLifecycleV1> {
  let raw: unknown;
  try {
    raw = await action();
  } catch {
    return fail("target_lifecycle_failed");
  }
  const parsed = parseSharedStateStorageLifecycleV1(raw);
  if (!parsed.ok) return fail("invalid_target_lifecycle");
  return parsed.value;
}

async function snapshot(
  target: SharedStateLeaseConformanceTargetV1,
): Promise<SharedStateLeaseConformanceSnapshotV1> {
  let raw: unknown;
  try {
    raw = await target.snapshot();
  } catch {
    return fail("target_snapshot_failed");
  }
  const parsed = sharedStateLeaseConformanceSnapshotV1Schema.safeParse(raw);
  if (!parsed.success) return fail("invalid_target_snapshot");
  return deepFreeze(parsed.data);
}

function requireReady(result: SharedStateStorageLifecycleV1): void {
  if (result.state !== "ready" || result.reasonCodes.length !== 0) {
    fail("target_lifecycle_failed");
  }
}

/**
 * Runs exactly the bounded Phase 2.1 lease/claim slice and returns only a
 * strict, public-safe report. A failing target produces a closed error code;
 * target values and thrown messages are never reflected.
 */
export async function runSharedStateLeaseConformanceV1(
  factory: SharedStateLeaseConformanceTargetFactoryV1,
): Promise<SharedStateLeaseConformanceReportV1> {
  let transactionCount = 0;

  async function transact<Operation extends SharedStateLeaseOperationV1>(
    target: SharedStateLeaseConformanceTargetV1,
    command: LeaseCommandForV1<Operation>,
  ): Promise<LeaseResultForV1<Operation>> {
    transactionCount += 1;
    if (
      transactionCount
      > SHARED_STATE_LEASE_CONFORMANCE_V1.transactionLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.transact("primary", command);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== command.operation) {
      return fail("invalid_target_result");
    }
    return parsed.value as LeaseResultForV1<Operation>;
  }

  const clock = new InjectedDeterministicFakeClockV1();
  const target = await createTarget(factory, clock);
  requireReady(await lifecycle(() => target.openSingleton("primary")));

  const order = seededDeterministicContenderOrderV1();
  const barrier = new ExplicitPromiseBarrierV1(
    SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount,
  );
  const contenders = order.map((contenderIndex) => {
    const command = claimCommand(contenderIndex, "0");
    return {
      contenderIndex,
      command,
      resultPromise: (async () => {
        await barrier.arriveAndWait();
        return transact(target, command);
      })(),
    };
  });
  await barrier.waitUntilAllArrived();
  barrier.release();
  const barrierResults = await Promise.all(
    contenders.map(async (entry) => ({
      contenderIndex: entry.contenderIndex,
      command: entry.command,
      result: await entry.resultPromise,
    })),
  );

  const winners = barrierResults.filter(
    (entry) => entry.result.status === "committed",
  );
  const conflicts = barrierResults.filter(
    (entry) => (
      entry.result.status === "rejected"
      && entry.result.reasonCode === "claim_conflict"
    ),
  );
  if (
    winners.length !== 1
    || conflicts.length !== 31
    || winners[0]?.contenderIndex !== order[0]
  ) {
    fail("claim_outcome_mismatch");
  }
  const winner = winners[0]!;
  if (winner.result.status !== "committed") {
    return fail("claim_outcome_mismatch");
  }
  const firstFence = BigInt(winner.result.result.fencingToken);
  if (firstFence <= 0n || !winner.result.result.attemptKeyDigest) {
    fail("attempt_binding_mismatch");
  }
  const afterBarrier = await snapshot(target);
  if (
    afterBarrier.attemptCount !== 1
    || afterBarrier.activeClaim !== true
  ) {
    fail("attempt_binding_mismatch");
  }

  const renewal = await transact(
    target,
    renewCommand(winner.command, winner.result),
  );
  if (renewal.status !== "committed") fail("attempt_binding_mismatch");
  const afterRenewal = await snapshot(target);
  if (afterRenewal.attemptCount !== 1) fail("attempt_binding_mismatch");

  clock.advanceExactlyBy(
    SHARED_STATE_LEASE_CONFORMANCE_V1.leaseDurationMs,
  );
  const reclaimedCommand = claimCommand(
    SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount,
    renewal.result.resourceVersion,
  );
  const reclaimed = await transact(target, reclaimedCommand);
  if (reclaimed.status !== "committed") fail("claim_outcome_mismatch");
  const secondFence = BigInt(reclaimed.result.fencingToken);
  if (secondFence <= firstFence) fail("fence_not_monotonic");

  const staleBaseline = await snapshot(target);
  for (const command of staleCommands(
    winner.command,
    winner.result,
    renewal.result.resourceVersion,
  )) {
    const staleResult = await transact(target, command);
    if (
      staleResult.status !== "rejected"
      || staleResult.reasonCode !== "stale_fence"
    ) {
      fail("stale_fence_mismatch");
    }
    if (!sameSnapshot(staleBaseline, await snapshot(target))) {
      fail("state_changed_on_rejection");
    }
  }

  const beforeSecondOwner = await snapshot(target);
  const secondOwner = await lifecycle(
    () => target.openSingleton("secondary"),
  );
  if (
    secondOwner.state !== "failed"
    || secondOwner.reasonCodes.length !== 1
    || secondOwner.reasonCodes[0] !== "ownership_conflict"
  ) {
    fail("singleton_not_exclusive");
  }
  if (!sameSnapshot(beforeSecondOwner, await snapshot(target))) {
    fail("singleton_not_exclusive");
  }

  const beforeClose = await snapshot(target);
  const closed = await lifecycle(() => target.closeSingleton("primary"));
  if (
    closed.state !== "closed"
    || closed.reasonCodes.length !== 1
    || closed.reasonCodes[0] !== "close_requested"
  ) {
    fail("target_lifecycle_failed");
  }
  requireReady(await lifecycle(() => target.openSingleton("primary")));
  if (!sameSnapshot(beforeClose, await snapshot(target))) {
    fail("reopen_snapshot_mismatch");
  }

  const release = await transact(
    target,
    commandFor("releaseLease", {
      namespace: reclaimedCommand.input.namespace,
      resourceKeyDigest: reclaimedCommand.input.resourceKeyDigest,
      ownerKeyDigest: reclaimedCommand.input.ownerKeyDigest,
      attemptKeyDigest: reclaimed.result.attemptKeyDigest,
      fencingToken: reclaimed.result.fencingToken,
      expectedResourceVersion: reclaimed.result.resourceVersion,
      releaseKind: "release",
    }),
  );
  if (release.status !== "committed") fail("claim_outcome_mismatch");
  const laterClaim = await transact(
    target,
    claimCommand(
      SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount + 1,
      release.result.resourceVersion,
    ),
  );
  if (laterClaim.status !== "committed") fail("claim_outcome_mismatch");
  const thirdFence = BigInt(laterClaim.result.fencingToken);
  if (thirdFence <= secondFence) fail("fence_not_monotonic");
  await lifecycle(() => target.closeSingleton("primary"));

  const faultReports: Array<z.infer<typeof faultReportSchema>> = [];
  for (const faultPoint of SHARED_STATE_LEASE_FAULT_POINTS_V1) {
    const faultClock = new InjectedDeterministicFakeClockV1();
    const faultTarget = await createTarget(factory, faultClock);
    requireReady(
      await lifecycle(() => faultTarget.openSingleton("primary")),
    );
    const baseline = await snapshot(faultTarget);
    try {
      faultTarget.armTransactionFault(faultPoint);
    } catch {
      return fail("target_fault_control_failed");
    }
    const cleanCommand = claimCommand(0, "0");
    const failed = await transact(faultTarget, cleanCommand);
    if (
      failed.status !== "unavailable"
      || failed.reasonCode !== "authority_unavailable"
    ) {
      fail("transaction_not_atomic");
    }
    if (!sameSnapshot(baseline, await snapshot(faultTarget))) {
      fail("transaction_not_atomic");
    }
    const clean = await transact(faultTarget, cleanCommand);
    if (clean.status !== "committed") fail("transaction_not_atomic");
    const committed = await snapshot(faultTarget);
    if (
      committed.resourceBinding !== "bound"
      || committed.resourceState !== "claimed"
      || committed.resourceVersion !== "1"
      || committed.maximumFencingToken !== "1"
      || committed.activeClaim !== true
      || committed.attemptCount !== 1
      || committed.mutationCount !== 0
      || committed.auditCount !== 1
      || committed.outboxCount !== 1
    ) {
      fail("transaction_not_atomic");
    }
    await lifecycle(() => faultTarget.closeSingleton("primary"));
    faultReports.push({
      faultPoint,
      failedReasonCode: "authority_unavailable",
      rollback: "all-or-none",
      nextCleanClaim: "committed",
    });
  }

  if (
    transactionCount
    !== SHARED_STATE_LEASE_CONFORMANCE_V1.expectedTransactionCount
  ) {
    fail("operation_limit_exceeded");
  }

  const report = {
    kind: SHARED_STATE_LEASE_CONFORMANCE_V1.kind,
    harnessVersion: SHARED_STATE_LEASE_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    scope: SHARED_STATE_LEASE_CONFORMANCE_V1.scope,
    status: "passed",
    scheduler: {
      kind: "seeded-deterministic",
      seed: SHARED_STATE_LEASE_CONFORMANCE_V1.schedulerSeed,
      contenderCount: SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount,
      barrier: "explicit-promise",
      transactionLimit: SHARED_STATE_LEASE_CONFORMANCE_V1.transactionLimit,
      transactionCount,
    },
    claims: {
      committedAtBarrier: 1,
      deterministicConflictsAtBarrier: 31,
      conflictReasonCode: "claim_conflict",
      winnerSeededRank: 1,
      winnerAttemptCount: 1,
      winnerAuthorityCheck: "renewed",
      successfulClaimFencingTokens: [
        String(firstFence),
        String(secondFence),
        String(thirdFence),
      ],
      laterFencesStrictlyGreater: true,
    },
    expiry: {
      clock: "injected-fake",
      advance: "exactly-through-expiry",
      reclaim: "committed",
    },
    staleFence: {
      reasonCode: "stale_fence",
      renewRejections: 1,
      completeMutationRejections: 1,
      checkpointMutationRejections: 1,
      releaseRejections: 1,
      stateUnchanged: true,
    },
    transactionFaults: faultReports,
    closeReopen: {
      snapshot: "preserved",
      laterFence: "strictly-greater",
    },
    singleton: {
      secondSimultaneousOwner: "failed-closed",
      reasonCode: "ownership_conflict",
    },
  } as const;
  const parsedReport = sharedStateLeaseConformanceReportV1Schema.safeParse(
    report,
  );
  if (!parsedReport.success) return fail("report_invalid");
  return deepFreeze(parsedReport.data);
}

/**
 * TEST-ONLY deterministic lease reference model.
 *
 * This model is not a production adapter, is not a conforming SQLite or shared
 * backend, makes no durability/HA claim, and is not connected to broker
 * runtime. It exists only to prove that the backend-neutral Phase 2.1 harness
 * can detect the required lease/claim invariants deterministically.
 */

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_LEASE_FAULT_POINTS_V1,
  SharedStateLeaseConformanceErrorV1,
  sharedStateLeaseConformanceSnapshotV1Schema,
  type SharedStateLeaseConformanceClockV1,
  type SharedStateLeaseConformanceOwnerSlotV1,
  type SharedStateLeaseConformanceSnapshotV1,
  type SharedStateLeaseConformanceTargetFactoryV1,
  type SharedStateLeaseConformanceTargetV1,
  type SharedStateLeaseFaultPointV1,
  type SharedStateLeaseOperationV1,
  type SharedStateLeaseTransactionCommandV1,
  type SharedStateLeaseTransactionResultV1,
} from "./shared-state-lease-conformance-harness-v1.js";

export const TEST_ONLY_DETERMINISTIC_LEASE_REFERENCE_MODEL_V1 = Object.freeze({
  role: "test-only-deterministic-reference-model",
  productionAdapter: false,
  conformingAdapterClaim: false,
  backendClassClaim: "none",
  runtimeIntegration: "not-attached",
} as const);

interface ActiveClaim {
  readonly ownerKeyDigest: string;
  readonly attemptKeyDigest: string;
  readonly fencingToken: bigint;
  readonly expiresAtLogicalMilliseconds: bigint;
}

interface ModelState {
  resourceKeyDigest: string | null;
  resourceState: "queued" | "claimed";
  resourceVersion: bigint;
  maximumFencingToken: bigint;
  activeClaim: ActiveClaim | null;
  attemptCount: number;
  mutationCount: number;
  auditCount: number;
  outboxCount: number;
}

type ClaimCommand = Extract<
  SharedStateLeaseTransactionCommandV1,
  { readonly operation: "claimLease" }
>;
type RenewCommand = Extract<
  SharedStateLeaseTransactionCommandV1,
  { readonly operation: "renewLease" }
>;
type MutationCommand = Extract<
  SharedStateLeaseTransactionCommandV1,
  { readonly operation: "mutateWithFence" }
>;
type ReleaseCommand = Extract<
  SharedStateLeaseTransactionCommandV1,
  { readonly operation: "releaseLease" }
>;
type AuthorityCommand = RenewCommand | MutationCommand | ReleaseCommand;

function invariant(): never {
  throw new SharedStateLeaseConformanceErrorV1("reference_model_invariant");
}

function initialState(): ModelState {
  return {
    resourceKeyDigest: null,
    resourceState: "queued",
    resourceVersion: 0n,
    maximumFencingToken: 0n,
    activeClaim: null,
    attemptCount: 0,
    mutationCount: 0,
    auditCount: 0,
    outboxCount: 0,
  };
}

function cloneState(state: ModelState): ModelState {
  return {
    ...state,
    activeClaim: state.activeClaim === null
      ? null
      : { ...state.activeClaim },
  };
}

function lifecycle(
  state: "ready" | "closed" | "failed",
  reasonCodes: readonly (
    | "close_requested"
    | "ownership_conflict"
    | "lost_fence"
  )[],
): SharedStateStorageLifecycleV1 {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  if (!parsed.ok) return invariant();
  return parsed.value;
}

function transactionResult(
  operation: SharedStateLeaseOperationV1,
  body: Record<string, unknown>,
): SharedStateLeaseTransactionResultV1 {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: V.operationConsistency[operation],
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== operation) return invariant();
  return parsed.value as SharedStateLeaseTransactionResultV1;
}

function unavailable(
  operation: SharedStateLeaseOperationV1,
  reasonCode: "authority_unavailable" | "lost_ownership",
): SharedStateLeaseTransactionResultV1 {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
}

function rejected(
  operation: SharedStateLeaseOperationV1,
  reasonCode: string,
): SharedStateLeaseTransactionResultV1 {
  return transactionResult(operation, {
    status: "rejected",
    completeness: "complete",
    reasonCode,
  });
}

function committed(
  operation: SharedStateLeaseOperationV1,
  result: Record<string, unknown>,
): SharedStateLeaseTransactionResultV1 {
  return transactionResult(operation, {
    status: "committed",
    completeness: "complete",
    result,
  });
}

function attemptDigest(
  namespace: string,
  attemptNumber: number,
): string {
  const result = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.lease.attempt-key",
    namespace,
    components: [
      {
        field: "resourceId",
        type: "utf8",
        value: "test-reference-resource",
      },
      {
        field: "attemptNumber",
        type: "uint",
        value: String(attemptNumber),
      },
    ],
  });
  if (!result.ok) return invariant();
  return result.value.digest;
}

/**
 * A bounded in-memory state machine used only by the adjacent conformance
 * test. Close/reopen retains this model state so the harness can exercise the
 * continuity requirement without representing a real durable backend.
 */
export class TestOnlyDeterministicLeaseReferenceModelV1
implements SharedStateLeaseConformanceTargetV1 {
  readonly #clock: SharedStateLeaseConformanceClockV1;
  #state = initialState();
  #singletonOwner: SharedStateLeaseConformanceOwnerSlotV1 | null = null;
  #armedFault: SharedStateLeaseFaultPointV1 | null = null;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(clock: SharedStateLeaseConformanceClockV1) {
    this.#clock = clock;
  }

  async openSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown> {
    if (this.#singletonOwner !== null) {
      return lifecycle("failed", ["ownership_conflict"]);
    }
    this.#singletonOwner = ownerSlot;
    return lifecycle("ready", []);
  }

  async closeSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown> {
    if (this.#singletonOwner !== ownerSlot) {
      return lifecycle("failed", ["lost_fence"]);
    }
    this.#singletonOwner = null;
    this.#armedFault = null;
    return lifecycle("closed", ["close_requested"]);
  }

  armTransactionFault(faultPoint: SharedStateLeaseFaultPointV1): void {
    if (
      this.#armedFault !== null
      || !SHARED_STATE_LEASE_FAULT_POINTS_V1.includes(faultPoint)
    ) {
      invariant();
    }
    this.#armedFault = faultPoint;
  }

  async snapshot(): Promise<unknown> {
    const raw = {
      kind: "SharedStateLeaseConformanceSnapshotV1",
      snapshotVersion: 1,
      resourceBinding: this.#state.resourceKeyDigest === null
        ? "unbound"
        : "bound",
      resourceState: this.#state.resourceState,
      resourceVersion: String(this.#state.resourceVersion),
      maximumFencingToken: String(this.#state.maximumFencingToken),
      activeClaim: this.#state.activeClaim !== null,
      attemptCount: this.#state.attemptCount,
      mutationCount: this.#state.mutationCount,
      auditCount: this.#state.auditCount,
      outboxCount: this.#state.outboxCount,
    } as const;
    const parsed = sharedStateLeaseConformanceSnapshotV1Schema.safeParse(raw);
    if (!parsed.success) return invariant();
    return Object.freeze(parsed.data) as SharedStateLeaseConformanceSnapshotV1;
  }

  async transact(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
    command: SharedStateLeaseTransactionCommandV1,
  ): Promise<unknown> {
    let release!: () => void;
    const predecessor = this.#transactionTail;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return this.#transactNow(ownerSlot, command);
    } finally {
      release();
    }
  }

  #transactNow(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
    command: SharedStateLeaseTransactionCommandV1,
  ): SharedStateLeaseTransactionResultV1 {
    const parsed = parseSharedStateTransactionCommandV1(command);
    if (
      !parsed.ok
      || ![
        "claimLease",
        "renewLease",
        "mutateWithFence",
        "releaseLease",
      ].includes(parsed.value.operation)
    ) {
      return invariant();
    }
    const leaseCommand = parsed.value as SharedStateLeaseTransactionCommandV1;
    if (this.#singletonOwner !== ownerSlot) {
      return unavailable(leaseCommand.operation, "lost_ownership");
    }
    switch (leaseCommand.operation) {
      case "claimLease":
        return this.#claim(leaseCommand);
      case "renewLease":
        return this.#renew(leaseCommand);
      case "mutateWithFence":
        return this.#mutate(leaseCommand);
      case "releaseLease":
        return this.#release(leaseCommand);
      default: {
        const exhaustive: never = leaseCommand;
        return exhaustive;
      }
    }
  }

  #takeFault(): SharedStateLeaseFaultPointV1 | null {
    const fault = this.#armedFault;
    this.#armedFault = null;
    return fault;
  }

  #faulted(
    operation: SharedStateLeaseOperationV1,
    fault: SharedStateLeaseFaultPointV1 | null,
    point: SharedStateLeaseFaultPointV1,
  ): SharedStateLeaseTransactionResultV1 | null {
    return fault === point
      ? unavailable(operation, "authority_unavailable")
      : null;
  }

  #resourceMismatch(resourceKeyDigest: string): boolean {
    return (
      this.#state.resourceKeyDigest !== null
      && this.#state.resourceKeyDigest !== resourceKeyDigest
    );
  }

  #claim(command: ClaimCommand): SharedStateLeaseTransactionResultV1 {
    const { input } = command;
    if (this.#resourceMismatch(input.resourceKeyDigest)) {
      return rejected(command.operation, "invalid_state_transition");
    }
    const now = this.#clock.readLogicalMilliseconds();
    if (
      this.#state.activeClaim !== null
      && now < this.#state.activeClaim.expiresAtLogicalMilliseconds
    ) {
      return rejected(command.operation, "claim_conflict");
    }
    if (BigInt(input.expectedResourceVersion) !== this.#state.resourceVersion) {
      return rejected(command.operation, "version_conflict");
    }

    const fault = this.#takeFault();
    const before = this.#faulted(
      command.operation,
      fault,
      "before_mutation",
    );
    if (before !== null) return before;

    const working = cloneState(this.#state);
    working.resourceKeyDigest = input.resourceKeyDigest;
    working.resourceState = "claimed";
    working.resourceVersion += 1n;
    working.maximumFencingToken += 1n;
    working.attemptCount += 1;
    const generatedAttemptDigest = attemptDigest(
      input.namespace,
      working.attemptCount,
    );
    working.activeClaim = {
      ownerKeyDigest: input.ownerKeyDigest,
      attemptKeyDigest: generatedAttemptDigest,
      fencingToken: working.maximumFencingToken,
      expiresAtLogicalMilliseconds:
        now + BigInt(input.leaseDurationMs),
    };
    const afterResource = this.#faulted(
      command.operation,
      fault,
      "after_resource_mutation",
    );
    if (afterResource !== null) return afterResource;

    working.auditCount += 1;
    working.outboxCount += 1;
    const afterEffects = this.#faulted(
      command.operation,
      fault,
      "after_audit_outbox_staging",
    );
    if (afterEffects !== null) return afterEffects;
    const beforeCommit = this.#faulted(
      command.operation,
      fault,
      "before_commit",
    );
    if (beforeCommit !== null) return beforeCommit;

    this.#state = working;
    return committed(command.operation, {
      decision: "claimed",
      attemptKeyDigest: generatedAttemptDigest,
      fencingToken: String(working.maximumFencingToken),
      resourceVersion: String(working.resourceVersion),
      leaseExpiresInMs: input.leaseDurationMs,
    });
  }

  #authorityRejection(
    command: AuthorityCommand,
    checkExpiry: boolean,
  ): string | null {
    const { input } = command;
    if (BigInt(input.fencingToken) !== this.#state.maximumFencingToken) {
      return "stale_fence";
    }
    const active = this.#state.activeClaim;
    if (active === null) {
      return command.operation === "releaseLease"
        ? "invalid_state_transition"
        : "lease_expired";
    }
    if (input.attemptKeyDigest !== active.attemptKeyDigest) {
      return "stale_fence";
    }
    if (input.ownerKeyDigest !== active.ownerKeyDigest) {
      return "owner_mismatch";
    }
    if (
      checkExpiry
      && this.#clock.readLogicalMilliseconds()
        >= active.expiresAtLogicalMilliseconds
    ) {
      return "lease_expired";
    }
    if (BigInt(input.expectedResourceVersion) !== this.#state.resourceVersion) {
      return "version_conflict";
    }
    return null;
  }

  #renew(command: RenewCommand): SharedStateLeaseTransactionResultV1 {
    const authorityRejection = this.#authorityRejection(command, true);
    if (authorityRejection !== null) {
      return rejected(command.operation, authorityRejection);
    }
    const fault = this.#takeFault();
    const before = this.#faulted(
      command.operation,
      fault,
      "before_mutation",
    );
    if (before !== null) return before;
    const working = cloneState(this.#state);
    working.resourceVersion += 1n;
    if (working.activeClaim === null) return invariant();
    working.activeClaim = {
      ...working.activeClaim,
      expiresAtLogicalMilliseconds:
        this.#clock.readLogicalMilliseconds()
        + BigInt(command.input.leaseDurationMs),
    };
    const afterResource = this.#faulted(
      command.operation,
      fault,
      "after_resource_mutation",
    );
    if (afterResource !== null) return afterResource;
    working.auditCount += 1;
    const afterEffects = this.#faulted(
      command.operation,
      fault,
      "after_audit_outbox_staging",
    );
    if (afterEffects !== null) return afterEffects;
    const beforeCommit = this.#faulted(
      command.operation,
      fault,
      "before_commit",
    );
    if (beforeCommit !== null) return beforeCommit;
    this.#state = working;
    return committed(command.operation, {
      decision: "renewed",
      resourceVersion: String(working.resourceVersion),
      leaseExpiresInMs: command.input.leaseDurationMs,
    });
  }

  #mutate(command: MutationCommand): SharedStateLeaseTransactionResultV1 {
    const authorityRejection = this.#authorityRejection(command, true);
    if (authorityRejection !== null) {
      return rejected(command.operation, authorityRejection);
    }
    const fault = this.#takeFault();
    const before = this.#faulted(
      command.operation,
      fault,
      "before_mutation",
    );
    if (before !== null) return before;
    const working = cloneState(this.#state);
    working.resourceVersion += 1n;
    working.mutationCount += 1;
    if (command.input.mutationKind !== "checkpoint") {
      working.resourceState = "queued";
      working.activeClaim = null;
    }
    const afterResource = this.#faulted(
      command.operation,
      fault,
      "after_resource_mutation",
    );
    if (afterResource !== null) return afterResource;
    working.auditCount += 1;
    working.outboxCount += 1;
    const afterEffects = this.#faulted(
      command.operation,
      fault,
      "after_audit_outbox_staging",
    );
    if (afterEffects !== null) return afterEffects;
    const beforeCommit = this.#faulted(
      command.operation,
      fault,
      "before_commit",
    );
    if (beforeCommit !== null) return beforeCommit;
    this.#state = working;
    return committed(command.operation, {
      decision: "applied",
      resourceVersion: String(working.resourceVersion),
    });
  }

  #release(command: ReleaseCommand): SharedStateLeaseTransactionResultV1 {
    const authorityRejection = this.#authorityRejection(command, false);
    if (authorityRejection !== null) {
      return rejected(command.operation, authorityRejection);
    }
    const fault = this.#takeFault();
    const before = this.#faulted(
      command.operation,
      fault,
      "before_mutation",
    );
    if (before !== null) return before;
    const working = cloneState(this.#state);
    working.resourceVersion += 1n;
    working.resourceState = "queued";
    working.activeClaim = null;
    const afterResource = this.#faulted(
      command.operation,
      fault,
      "after_resource_mutation",
    );
    if (afterResource !== null) return afterResource;
    working.auditCount += 1;
    working.outboxCount += 1;
    const afterEffects = this.#faulted(
      command.operation,
      fault,
      "after_audit_outbox_staging",
    );
    if (afterEffects !== null) return afterEffects;
    const beforeCommit = this.#faulted(
      command.operation,
      fault,
      "before_commit",
    );
    if (beforeCommit !== null) return beforeCommit;
    this.#state = working;
    return committed(command.operation, {
      decision: "released",
      resourceVersion: String(working.resourceVersion),
    });
  }
}

export function createTestOnlyDeterministicLeaseReferenceModelFactoryV1():
SharedStateLeaseConformanceTargetFactoryV1 {
  return Object.freeze({
    async create({
      clock,
    }: {
      readonly clock: SharedStateLeaseConformanceClockV1;
    }) {
      return new TestOnlyDeterministicLeaseReferenceModelV1(clock);
    },
  });
}

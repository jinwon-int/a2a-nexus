import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateDrainRequestV1,
  parseSharedStateHealthProjectionV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateStorageMetadataV1,
  parseSharedStateStorageOpenRequirementsV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  validateSharedStateStorageOpenCompatibilityV1,
  type SharedStateContractErrorCodeV1,
  type SharedStateOperationV1,
  type SharedStateParseResultV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
  type SharedStateWriterModelV1,
} from "./shared-state-storage-contract-v1.js";

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`;

const consistency = {
  kind: V.kinds.consistency,
  declarationsVersion: V.versions.declarations,
  ...V.consistencyGuarantees,
};

const completeness = {
  kind: V.kinds.completeness,
  declarationsVersion: V.versions.declarations,
  ...V.completenessGuarantees,
};

function capabilities(writerModel: SharedStateWriterModelV1) {
  return {
    kind: V.kinds.capabilities,
    capabilitiesVersion: V.versions.capabilities,
    atomicCompareAndSet: true,
    linearizablePerKey: true,
    durableLogicalExpiry: true,
    clockFloorProtection: true,
    monotonicFencingTokens: true,
    atomicIdempotencyDomainOutbox: true,
    stablePerStreamOutboxOrdering: true,
    durableOutboxAckState: true,
    durableProjectionCheckpoints: true,
    exactProjectionBatchRollback: true,
    exclusiveSingletonOwnership: writerModel === "single",
  };
}

const sqliteMetadata = {
  kind: V.kinds.metadata,
  metadataVersion: V.versions.metadata,
  contractVersion: V.versions.contract,
  operationVersion: V.versions.operation,
  implementationVersion: "sqlite-adapter.1.0.0",
  backendClass: "sqlite-single-writer",
  durability: "durable",
  writerModel: "single",
  schemaVersion: 1,
  clockAuthority: "adapter-controlled",
  migrationState: "complete",
  capabilities: capabilities("single"),
  consistency,
  completeness,
} as const;

const sharedMetadata = {
  ...sqliteMetadata,
  implementationVersion: "shared-adapter.1.0.0",
  backendClass: "shared",
  writerModel: "multi",
  clockAuthority: "backend-server",
  capabilities: capabilities("multi"),
} as const;

const sqliteOpenRequirements = {
  kind: V.kinds.openRequirements,
  requirementsVersion: V.versions.openRequirements,
  contractVersion: V.versions.contract,
  operationVersion: V.versions.operation,
  expectedBackendClass: "sqlite-single-writer",
  expectedWriterModel: "single",
  expectedSchemaVersion: 1,
  expectedProcessCount: 1,
  clockAuthority: "adapter-controlled",
  callerClockAllowed: false,
  migrationState: "complete",
  topologyOwnership: "required",
  requiredCapabilities: capabilities("single"),
  requiredConsistency: consistency,
  requiredCompleteness: completeness,
} as const;

const legacyHealth = {
  kind: V.kinds.health,
  specVersion: V.versions.health,
  configuredGrade: "single-process",
  effectiveGrade: "single-process",
  gradeDefaulted: true,
  serving: true,
  reasonCodes: [],
  adapter: {
    contractVersion: null,
    backendClass: "legacy-process",
    lifecycle: "ready",
    durability: "volatile",
    writerModel: "single",
    schemaVersion: null,
    clockAuthority: null,
    migrationState: null,
  },
  topology: {
    expectedProcessCount: 1,
    ownership: "held",
  },
  clock: {
    safety: "safe",
  },
  consistency: {
    ...V.consistencyGuarantees,
  },
  completeness: {
    graphProjection: "incomplete",
    negativeEvidenceAllowed: false,
  },
  primitives: {
    replay: {
      source: "process",
      durability: "volatile",
      continuity: "reset",
      resetRisk: true,
      epochAgeBand: "under-5m",
      pressureBand: "low",
      lastResetReason: "process_start",
    },
    rateLimit: {
      source: "process",
      durability: "volatile",
      continuity: "reset",
      resetRisk: true,
      epochAgeBand: "under-5m",
      pressureBand: "none",
      lastResetReason: "process_start",
    },
  },
} as const;

const sharedHealth = {
  ...legacyHealth,
  configuredGrade: "shared-state-ha",
  effectiveGrade: "shared-state-ha",
  gradeDefaulted: false,
  adapter: {
    contractVersion: V.versions.contract,
    backendClass: "shared",
    lifecycle: "ready",
    durability: "durable",
    writerModel: "multi",
    schemaVersion: 1,
    clockAuthority: "backend-server",
    migrationState: "complete",
  },
  topology: {
    expectedProcessCount: 3,
    ownership: "not-required",
  },
  completeness: {
    graphProjection: "complete",
    negativeEvidenceAllowed: true,
  },
  primitives: {
    replay: {
      source: "adapter",
      durability: "durable",
      continuity: "preserved",
      resetRisk: false,
      epochAgeBand: "under-1h",
      pressureBand: "low",
      lastResetReason: null,
    },
    rateLimit: {
      source: "adapter",
      durability: "durable",
      continuity: "preserved",
      resetRisk: false,
      epochAgeBand: "under-1h",
      pressureBand: "medium",
      lastResetReason: null,
    },
  },
} as const;

const leaseAuthority = {
  namespace: "broker.lease",
  resourceKeyDigest: digest("1"),
  ownerKeyDigest: digest("2"),
  attemptKeyDigest: digest("3"),
  fencingToken: "7",
  expectedResourceVersion: "6",
};

const commandInputs = {
  consumeReplayNonce: {
    namespace: "security.replay",
    keyDigest: digest("1"),
    nonceDigest: digest("2"),
    ttlMs: 60_000,
  },
  reserveRateLimitCost: {
    namespace: "security.rate-limit",
    bucketKeyDigest: digest("3"),
    cost: 1,
    limit: 100,
    windowMs: 60_000,
  },
  claimLease: {
    namespace: "broker.lease",
    resourceKeyDigest: digest("1"),
    ownerKeyDigest: digest("2"),
    leaseDurationMs: 30_000,
    expectedResourceVersion: "0",
  },
  renewLease: {
    ...leaseAuthority,
    leaseDurationMs: 30_000,
  },
  mutateWithFence: {
    ...leaseAuthority,
    mutationKind: "checkpoint",
    mutationDigest: digest("4"),
  },
  releaseLease: {
    ...leaseAuthority,
    releaseKind: "release",
  },
  executeIdempotent: {
    namespace: "broker.idempotency",
    keyDigest: digest("4"),
    payloadFingerprint: digest("5"),
    retentionPolicyVersion: "terminal-effects.v1",
    effect: {
      kind: "domain-mutation-with-outbox",
      domainMutationDigest: digest("6"),
      outbox: {
        streamKeyDigest: digest("7"),
        eventKeyDigest: digest("8"),
        payloadDigest: digest("9"),
        retentionPolicyVersion: "terminal-outbox.v1",
      },
    },
  },
  appendOutbox: {
    namespace: "broker.outbox",
    streamKeyDigest: digest("7"),
    idempotencyKeyDigest: digest("4"),
    eventKeyDigest: digest("8"),
    payloadDigest: digest("9"),
    retentionPolicyVersion: "terminal-outbox.v1",
  },
  updateOutboxReceipt: {
    namespace: "broker.outbox",
    eventKeyDigest: digest("8"),
    receiptEvidenceDigest: digest("a"),
    expectedReceiptState: "pending",
    newReceiptState: "confirmed",
  },
  acknowledgeOutbox: {
    namespace: "broker.outbox",
    eventKeyDigest: digest("8"),
    receiptEvidenceDigest: digest("a"),
    expectedAcknowledgmentState: "unacknowledged",
  },
  appendGraphSource: {
    namespace: "broker.claim-graph",
    sourceStreamKeyDigest: digest("b"),
    sourceFactDigest: digest("c"),
    nodeType: "Claim",
    expectedSourceSequence: "0",
  },
  applyGraphProjectionBatch: {
    namespace: "broker.claim-graph",
    projectionVersion: "claim-graph.v1",
    batchKeyDigest: digest("d"),
    batchDigest: digest("e"),
    inverseDigest: digest("f"),
    sourceSequenceFrom: "1",
    sourceSequenceThrough: "4",
    expectedCheckpointSequence: "0",
  },
  rollbackGraphProjectionBatch: {
    namespace: "broker.claim-graph",
    projectionVersion: "claim-graph.v1",
    batchKeyDigest: digest("d"),
    rollbackBatchKeyDigest: digest("e"),
    inverseDigest: digest("f"),
    expectedCheckpointSequence: "4",
  },
} as const satisfies Record<SharedStateOperationV1, unknown>;

const committedResults = {
  consumeReplayNonce: {
    decision: "accepted",
    expiresInMs: 60_000,
  },
  reserveRateLimitCost: {
    decision: "accepted",
    remaining: 99,
    resetInMs: 60_000,
  },
  claimLease: {
    decision: "claimed",
    attemptKeyDigest: digest("3"),
    fencingToken: "1",
    resourceVersion: "1",
    leaseExpiresInMs: 30_000,
  },
  renewLease: {
    decision: "renewed",
    resourceVersion: "2",
    leaseExpiresInMs: 30_000,
  },
  mutateWithFence: {
    decision: "applied",
    resourceVersion: "3",
  },
  releaseLease: {
    decision: "released",
    resourceVersion: "4",
  },
  executeIdempotent: {
    decision: "executed",
    outcomeDigest: digest("6"),
  },
  appendOutbox: {
    decision: "appended",
    eventKeyDigest: digest("8"),
    streamSequence: "1",
  },
  updateOutboxReceipt: {
    decision: "updated",
    receiptState: "confirmed",
  },
  acknowledgeOutbox: {
    decision: "acknowledged",
    acknowledgmentState: "acknowledged",
  },
  appendGraphSource: {
    decision: "appended",
    sourceSequence: "1",
  },
  applyGraphProjectionBatch: {
    decision: "applied",
    checkpointSequence: "4",
  },
  rollbackGraphProjectionBatch: {
    decision: "rolled_back",
    checkpointSequence: "0",
  },
} as const satisfies Record<SharedStateOperationV1, unknown>;

function command(operation: SharedStateOperationV1): unknown {
  return {
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input: commandInputs[operation],
  };
}

function transactionResult(
  operation: SharedStateOperationV1,
  body: Record<string, unknown>,
): unknown {
  return {
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: V.operationConsistency[operation],
    ...body,
  };
}

function expectError<T>(
  parsed: SharedStateParseResultV1<T>,
  code: SharedStateContractErrorCodeV1,
  path?: readonly (string | number)[],
): void {
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.code, code);
  if (path) assert.deepEqual(parsed.error.path, path);
}

function assertCommandUnionIsExhaustive(
  parsed: SharedStateTransactionCommandV1,
): SharedStateOperationV1 {
  switch (parsed.operation) {
    case "consumeReplayNonce":
    case "reserveRateLimitCost":
    case "claimLease":
    case "renewLease":
    case "mutateWithFence":
    case "releaseLease":
    case "executeIdempotent":
    case "appendOutbox":
    case "updateOutboxReceipt":
    case "acknowledgeOutbox":
    case "appendGraphSource":
    case "applyGraphProjectionBatch":
    case "rollbackGraphProjectionBatch":
      return parsed.operation;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

function assertResultUnionIsExhaustive(
  parsed: SharedStateTransactionResultV1,
): string {
  switch (parsed.status) {
    case "committed":
      return parsed.result.decision;
    case "rejected":
    case "unavailable":
      return parsed.reasonCode;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

test("pins the V1 identity, operation set, enums, and reason codes in one frozen catalog", () => {
  assert.equal(V.versions.contract, "a2a.shared-state.storage/v1");
  assert.deepEqual(V.operations, [
    "consumeReplayNonce",
    "reserveRateLimitCost",
    "claimLease",
    "renewLease",
    "mutateWithFence",
    "releaseLease",
    "executeIdempotent",
    "appendOutbox",
    "updateOutboxReceipt",
    "acknowledgeOutbox",
    "appendGraphSource",
    "applyGraphProjectionBatch",
    "rollbackGraphProjectionBatch",
  ]);
  assertDeepFrozen(V);

  const enumArrays: readonly (readonly string[])[] = [
    V.backendClasses,
    V.healthBackendClasses,
    V.writerModels,
    V.lifecycleStates,
    V.lifecycleReasonCodes,
    V.configuredGrades,
    V.effectiveGrades,
    V.readinessReasonCodes,
    V.operations,
    V.unavailableReasonCodes,
    V.parserErrorCodes,
  ];
  for (const values of enumArrays) {
    assert.equal(new Set(values).size, values.length);
  }
  for (const operation of V.operations) {
    assert.ok(V.operationDecisions[operation].length > 0);
    assert.ok(V.operationRejectionReasonCodes[operation].length > 0);
  }
});

test("accepts both backend-neutral V1 metadata profiles and exact open requirements", () => {
  for (const metadata of [sqliteMetadata, sharedMetadata]) {
    const parsed = parseSharedStateStorageMetadataV1(metadata);
    assert.equal(parsed.ok, true);
  }
  assert.equal(
    parseSharedStateStorageOpenRequirementsV1(sqliteOpenRequirements).ok,
    true,
  );
  assert.equal(
    validateSharedStateStorageOpenCompatibilityV1(
      sqliteOpenRequirements,
      sqliteMetadata,
    ).ok,
    true,
  );
});

test("accepts closed lifecycle, drain, legacy health, and V1 HA health projections", () => {
  assert.equal(
    parseSharedStateStorageLifecycleV1({
      kind: V.kinds.lifecycle,
      lifecycleVersion: V.versions.lifecycle,
      contractVersion: V.versions.contract,
      state: "ready",
      reasonCodes: [],
    }).ok,
    true,
  );
  assert.equal(
    parseSharedStateDrainRequestV1({
      kind: V.kinds.drainRequest,
      drainVersion: V.versions.drain,
      contractVersion: V.versions.contract,
      timeoutMs: 5_000,
    }).ok,
    true,
  );
  assert.equal(parseSharedStateHealthProjectionV1(legacyHealth).ok, true);
  assert.equal(parseSharedStateHealthProjectionV1(sharedHealth).ok, true);
  assert.equal(
    parseSharedStateHealthProjectionV1({
      ...sharedHealth,
      serving: false,
      reasonCodes: ["adapter_unavailable", "incomplete_migration"],
      adapter: {
        ...sharedHealth.adapter,
        lifecycle: "opening",
        migrationState: "incomplete",
      },
    }).ok,
    true,
  );
});

test("parses every section 6.1 command and committed result exhaustively", () => {
  const seenCommands = new Set<SharedStateOperationV1>();
  const seenResults = new Set<SharedStateOperationV1>();

  for (const operation of V.operations) {
    const parsedCommand = parseSharedStateTransactionCommandV1(
      command(operation),
    );
    assert.equal(parsedCommand.ok, true, operation);
    if (parsedCommand.ok) {
      seenCommands.add(assertCommandUnionIsExhaustive(parsedCommand.value));
    }

    const parsedResult = parseSharedStateTransactionResultV1(
      transactionResult(operation, {
        status: "committed",
        completeness: "complete",
        result: committedResults[operation],
      }),
    );
    assert.equal(parsedResult.ok, true, operation);
    if (parsedResult.ok) {
      assert.ok(assertResultUnionIsExhaustive(parsedResult.value));
      seenResults.add(parsedResult.value.operation);
    }
  }

  assert.deepEqual([...seenCommands], [...V.operations]);
  assert.deepEqual([...seenResults], [...V.operations]);
});

test("parses every pinned rejection and unavailable reason for every operation", () => {
  for (const operation of V.operations) {
    for (const reasonCode of V.operationRejectionReasonCodes[operation]) {
      const parsed = parseSharedStateTransactionResultV1(
        transactionResult(operation, {
          status: "rejected",
          completeness: "complete",
          reasonCode,
        }),
      );
      assert.equal(parsed.ok, true, `${operation}:${reasonCode}`);
    }
    for (const reasonCode of V.unavailableReasonCodes) {
      const parsed = parseSharedStateTransactionResultV1(
        transactionResult(operation, {
          status: "unavailable",
          completeness: "unavailable",
          reasonCode,
        }),
      );
      assert.equal(parsed.ok, true, `${operation}:${reasonCode}`);
    }
  }
});

test("parses every alternate committed decision variant", () => {
  const alternates: Partial<Record<SharedStateOperationV1, unknown>> = {
    consumeReplayNonce: {
      decision: "replay",
      expiresInMs: 20_000,
    },
    reserveRateLimitCost: {
      decision: "rate_limited",
      resetInMs: 20_000,
    },
    executeIdempotent: {
      decision: "replayed",
      outcomeDigest: digest("6"),
    },
    appendOutbox: {
      decision: "replayed",
      eventKeyDigest: digest("8"),
      streamSequence: "1",
    },
    acknowledgeOutbox: {
      decision: "already_acknowledged",
      acknowledgmentState: "acknowledged",
    },
    appendGraphSource: {
      decision: "replayed",
      sourceSequence: "1",
    },
    applyGraphProjectionBatch: {
      decision: "replayed",
      checkpointSequence: "4",
    },
    rollbackGraphProjectionBatch: {
      decision: "replayed",
      checkpointSequence: "0",
    },
  };

  for (const [operation, result] of Object.entries(alternates)) {
    const parsed = parseSharedStateTransactionResultV1(
      transactionResult(operation as SharedStateOperationV1, {
        status: "committed",
        completeness: "complete",
        result,
      }),
    );
    assert.equal(parsed.ok, true, operation);
  }
});

test("fails closed on unknown contract, envelope, operation, lifecycle, health, and drain versions", () => {
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sqliteMetadata,
      contractVersion: "a2a.shared-state.storage/v2",
    }),
    "unknown_contract_version",
    ["contractVersion"],
  );
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sqliteMetadata,
      metadataVersion: 2,
    }),
    "unknown_metadata_version",
    ["metadataVersion"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...(command("consumeReplayNonce") as Record<string, unknown>),
      transactionVersion: 2,
    }),
    "unknown_transaction_version",
    ["transactionVersion"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...(command("consumeReplayNonce") as Record<string, unknown>),
      operationVersion: 2,
    }),
    "unknown_operation_version",
    ["operationVersion"],
  );
  expectError(
    parseSharedStateStorageLifecycleV1({
      kind: V.kinds.lifecycle,
      lifecycleVersion: 2,
      contractVersion: V.versions.contract,
      state: "ready",
      reasonCodes: [],
    }),
    "unknown_lifecycle_version",
    ["lifecycleVersion"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      specVersion: 2,
    }),
    "unknown_health_version",
    ["specVersion"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...sharedHealth,
      adapter: {
        ...sharedHealth.adapter,
        contractVersion: "a2a.shared-state.storage/v2",
      },
    }),
    "unknown_contract_version",
    ["adapter", "contractVersion"],
  );
  expectError(
    parseSharedStateDrainRequestV1({
      kind: V.kinds.drainRequest,
      drainVersion: 2,
      contractVersion: V.versions.contract,
      timeoutMs: 1,
    }),
    "unknown_drain_version",
    ["drainVersion"],
  );
});

test("fails closed on unknown fields and invalid discriminants", () => {
  const validCommand = command("consumeReplayNonce") as Record<string, unknown>;
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...(validCommand.input as Record<string, unknown>),
        extra: true,
      },
    }),
    "unknown_field",
    ["input", "extra"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      operation: "runBackendCommand",
    }),
    "invalid_discriminant",
    ["operation"],
  );
  expectError(
    parseSharedStateTransactionResultV1(
      transactionResult("appendOutbox", {
        status: "committed",
        completeness: "complete",
        result: committedResults.consumeReplayNonce,
      }),
    ),
    "operation_result_mismatch",
    ["result"],
  );
});

test("fails closed on capability downgrades and invalid backend combinations", () => {
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sqliteMetadata,
      capabilities: {
        ...sqliteMetadata.capabilities,
        clockFloorProtection: false,
      },
    }),
    "capability_downgrade",
    ["capabilities", "clockFloorProtection"],
  );
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sqliteMetadata,
      writerModel: "multi",
      clockAuthority: "backend-server",
      capabilities: capabilities("multi"),
    }),
    "invalid_capability_combination",
    ["writerModel"],
  );
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sharedMetadata,
      capabilities: {
        ...sharedMetadata.capabilities,
        exclusiveSingletonOwnership: true,
      },
    }),
    "invalid_capability_combination",
    ["capabilities", "exclusiveSingletonOwnership"],
  );
  expectError(
    parseSharedStateStorageOpenRequirementsV1({
      ...sqliteOpenRequirements,
      expectedProcessCount: 2,
    }),
    "invalid_capability_combination",
    ["expectedProcessCount"],
  );
});

test("detects open compatibility mismatches with stable error codes", () => {
  expectError(
    validateSharedStateStorageOpenCompatibilityV1(
      {
        ...sqliteOpenRequirements,
        expectedSchemaVersion: 2,
      },
      sqliteMetadata,
    ),
    "schema_version_mismatch",
    ["schemaVersion"],
  );
  expectError(
    validateSharedStateStorageOpenCompatibilityV1(
      {
        ...sqliteOpenRequirements,
        expectedBackendClass: "shared",
        expectedWriterModel: "multi",
        expectedProcessCount: 3,
        clockAuthority: "backend-server",
        topologyOwnership: "not-required",
        requiredCapabilities: capabilities("multi"),
      },
      sqliteMetadata,
    ),
    "backend_class_mismatch",
    ["backendClass"],
  );
});

test("rejects caller clocks, arbitrary backend commands, and sensitive connection fields", () => {
  const validCommand = command("consumeReplayNonce") as Record<string, unknown>;
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...(validCommand.input as Record<string, unknown>),
        nowMs: 1_700_000_000_000,
      },
    }),
    "caller_clock_forbidden",
    ["input", "nowMs"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...(validCommand.input as Record<string, unknown>),
        sql: "SELECT",
      },
    }),
    "backend_command_forbidden",
    ["input", "sql"],
  );

  const credentialField = ["cred", "entials"].join("");
  expectError(
    parseSharedStateStorageOpenRequirementsV1({
      ...sqliteOpenRequirements,
      [credentialField]: "forbidden-fixture",
    }),
    "sensitive_field_forbidden",
    [credentialField],
  );
  const dsnField = ["d", "sn"].join("");
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sqliteMetadata,
      [dsnField]: "forbidden-fixture",
    }),
    "sensitive_field_forbidden",
    [dsnField],
  );
  expectError(
    parseSharedStateStorageMetadataV1({
      ...sqliteMetadata,
      implementationVersion: "file:///tmp/adapter",
    }),
    "invalid_value",
    ["implementationVersion"],
  );
});

test("health/readiness projection rejects identities, digests, paths, and inconsistent serving claims", () => {
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      workerId: "worker-fixture",
    }),
    "identity_health_field_forbidden",
    ["workerId"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      primitives: {
        ...legacyHealth.primitives,
        replay: {
          ...legacyHealth.primitives.replay,
          nonceDigest: digest("1"),
        },
      },
    }),
    "identity_health_field_forbidden",
    ["primitives", "replay", "nonceDigest"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      artifactPath: "forbidden-fixture",
    }),
    "identity_health_field_forbidden",
    ["artifactPath"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      serving: false,
    }),
    "invalid_value",
    ["serving"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      completeness: {
        graphProjection: "incomplete",
        negativeEvidenceAllowed: true,
      },
    }),
    "invalid_value",
    ["completeness", "negativeEvidenceAllowed"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...sharedHealth,
      serving: false,
      reasonCodes: ["adapter_unavailable"],
      adapter: {
        ...sharedHealth.adapter,
        lifecycle: "opening",
        migrationState: "incomplete",
      },
    }),
    "invalid_value",
    ["reasonCodes"],
  );
});

test("rejects duplicate or state-inconsistent lifecycle/readiness reason codes", () => {
  expectError(
    parseSharedStateStorageLifecycleV1({
      kind: V.kinds.lifecycle,
      lifecycleVersion: V.versions.lifecycle,
      contractVersion: V.versions.contract,
      state: "failed",
      reasonCodes: ["unsafe_clock", "unsafe_clock"],
    }),
    "duplicate_value",
    ["reasonCodes", 1],
  );
  expectError(
    parseSharedStateStorageLifecycleV1({
      kind: V.kinds.lifecycle,
      lifecycleVersion: V.versions.lifecycle,
      contractVersion: V.versions.contract,
      state: "ready",
      reasonCodes: ["unsafe_clock"],
    }),
    "invalid_value",
    ["reasonCodes"],
  );
  expectError(
    parseSharedStateHealthProjectionV1({
      ...legacyHealth,
      serving: false,
      effectiveGrade: "multi-process-unsupported",
      reasonCodes: ["unsupported_topology", "unsupported_topology"],
      topology: {
        expectedProcessCount: 2,
        ownership: "conflict",
      },
    }),
    "duplicate_value",
    ["reasonCodes", 1],
  );
});

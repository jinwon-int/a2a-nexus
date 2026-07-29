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
  type SharedStateDigestDomainV1,
  type SharedStateOperationV1,
  type SharedStateParseResultV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
  type SharedStateWriterModelV1,
} from "./shared-state-storage-contract-v1.js";

const digest = (
  domain: SharedStateDigestDomainV1,
  namespace: string,
  digit: string,
): string =>
  `${V.versions.keyspace}|${domain}|${namespace}|sha256:${digit.repeat(64)}`;

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
  resourceKeyDigest: digest("broker.lease.resource-key", "broker.lease", "1"),
  ownerKeyDigest: digest("broker.lease.owner-key", "broker.lease", "2"),
  attemptKeyDigest: digest("broker.lease.attempt-key", "broker.lease", "3"),
  fencingToken: "7",
  expectedResourceVersion: "6",
};

const commandInputs = {
  consumeReplayNonce: {
    namespace: "security.replay",
    keyDigest: digest(
      "security.replay.requester-key",
      "security.replay",
      "1",
    ),
    nonceDigest: digest("security.replay.nonce", "security.replay", "2"),
    ttlMs: 60_000,
  },
  reserveRateLimitCost: {
    namespace: "security.rate-limit",
    bucketKeyDigest: digest(
      "security.rate-limit.bucket-key",
      "security.rate-limit",
      "3",
    ),
    cost: 1,
    limit: 100,
    windowMs: 60_000,
  },
  claimLease: {
    namespace: "broker.lease",
    resourceKeyDigest: digest("broker.lease.resource-key", "broker.lease", "1"),
    ownerKeyDigest: digest("broker.lease.owner-key", "broker.lease", "2"),
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
    mutationDigest: digest("broker.lease.mutation", "broker.lease", "4"),
  },
  releaseLease: {
    ...leaseAuthority,
    releaseKind: "release",
  },
  executeIdempotent: {
    namespace: "broker.idempotency",
    keyDigest: digest(
      "broker.idempotency.key",
      "broker.idempotency",
      "4",
    ),
    payloadFingerprint: digest(
      "broker.idempotency.payload-fingerprint",
      "broker.idempotency",
      "5",
    ),
    retentionPolicyVersion: "terminal-effects.v1",
    effect: {
      kind: "domain-mutation-with-outbox",
      domainMutationDigest: digest(
        "broker.idempotency.domain-mutation",
        "broker.idempotency",
        "6",
      ),
      outbox: {
        streamKeyDigest: digest(
          "broker.outbox.stream-key",
          "broker.idempotency",
          "7",
        ),
        eventKeyDigest: digest(
          "broker.outbox.event-key",
          "broker.idempotency",
          "8",
        ),
        payloadDigest: digest(
          "broker.outbox.payload",
          "broker.idempotency",
          "9",
        ),
        retentionPolicyVersion: "terminal-outbox.v1",
      },
    },
  },
  appendOutbox: {
    namespace: "broker.outbox",
    streamKeyDigest: digest("broker.outbox.stream-key", "broker.outbox", "7"),
    idempotencyKeyDigest: digest(
      "broker.outbox.idempotency-key",
      "broker.outbox",
      "4",
    ),
    eventKeyDigest: digest("broker.outbox.event-key", "broker.outbox", "8"),
    payloadDigest: digest("broker.outbox.payload", "broker.outbox", "9"),
    retentionPolicyVersion: "terminal-outbox.v1",
  },
  updateOutboxReceipt: {
    namespace: "broker.outbox",
    eventKeyDigest: digest("broker.outbox.event-key", "broker.outbox", "8"),
    receiptEvidenceDigest: digest(
      "broker.outbox.receipt-evidence",
      "broker.outbox",
      "a",
    ),
    expectedReceiptState: "pending",
    newReceiptState: "confirmed",
  },
  acknowledgeOutbox: {
    namespace: "broker.outbox",
    eventKeyDigest: digest("broker.outbox.event-key", "broker.outbox", "8"),
    receiptEvidenceDigest: digest(
      "broker.outbox.receipt-evidence",
      "broker.outbox",
      "a",
    ),
    expectedAcknowledgmentState: "unacknowledged",
  },
  appendGraphSource: {
    namespace: "broker.claim-graph",
    sourceStreamKeyDigest: digest(
      "broker.claim-graph.source-stream-key",
      "broker.claim-graph",
      "b",
    ),
    sourceFactDigest: digest(
      "broker.claim-graph.source-fact",
      "broker.claim-graph",
      "c",
    ),
    nodeType: "Claim",
    expectedSourceSequence: "0",
  },
  applyGraphProjectionBatch: {
    namespace: "broker.claim-graph",
    projectionVersion: "claim-graph.v1",
    batchKeyDigest: digest(
      "broker.claim-graph.projection-batch-key",
      "broker.claim-graph",
      "d",
    ),
    batchDigest: digest(
      "broker.claim-graph.projection-batch",
      "broker.claim-graph",
      "e",
    ),
    inverseDigest: digest(
      "broker.claim-graph.projection-inverse",
      "broker.claim-graph",
      "f",
    ),
    sourceSequenceFrom: "1",
    sourceSequenceThrough: "4",
    expectedCheckpointSequence: "0",
  },
  rollbackGraphProjectionBatch: {
    namespace: "broker.claim-graph",
    projectionVersion: "claim-graph.v1",
    batchKeyDigest: digest(
      "broker.claim-graph.projection-batch-key",
      "broker.claim-graph",
      "d",
    ),
    rollbackBatchKeyDigest: digest(
      "broker.claim-graph.rollback-batch-key",
      "broker.claim-graph",
      "e",
    ),
    inverseDigest: digest(
      "broker.claim-graph.projection-inverse",
      "broker.claim-graph",
      "f",
    ),
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
    attemptKeyDigest: digest("broker.lease.attempt-key", "broker.lease", "3"),
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
    outcomeDigest: digest(
      "broker.idempotency.outcome",
      "broker.idempotency",
      "6",
    ),
  },
  appendOutbox: {
    decision: "appended",
    eventKeyDigest: digest("broker.outbox.event-key", "broker.outbox", "8"),
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
      outcomeDigest: digest(
        "broker.idempotency.outcome",
        "broker.idempotency",
        "6",
      ),
    },
    appendOutbox: {
      decision: "replayed",
      eventKeyDigest: digest(
        "broker.outbox.event-key",
        "broker.outbox",
        "8",
      ),
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

test("transaction fields enforce keyspace version, purpose domain, and namespace", () => {
  const validCommand = command("consumeReplayNonce") as Record<string, unknown>;
  const validInput = validCommand.input as Record<string, unknown>;
  const keyDigest = validInput.keyDigest as string;

  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...validInput,
        keyDigest: keyDigest.replace(
          "security.replay.requester-key",
          "security.replay.nonce",
        ),
      },
    }),
    "digest_domain_mismatch",
    ["input", "keyDigest"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...validInput,
        keyDigest: keyDigest.replace(
          "|security.replay|sha256:",
          "|security.other|sha256:",
        ),
      },
    }),
    "digest_namespace_mismatch",
    ["input", "keyDigest"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...validInput,
        keyDigest: keyDigest.replace(
          V.versions.keyspace,
          "a2a.shared-state.keyspace/v2",
        ),
      },
    }),
    "unknown_keyspace_version",
    ["input", "keyDigest"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...validInput,
        keyDigest: keyDigest.replace(
          "security.replay.requester-key",
          "security.replay.unknown",
        ),
      },
    }),
    "unknown_digest_domain",
    ["input", "keyDigest"],
  );
  expectError(
    parseSharedStateTransactionCommandV1({
      ...validCommand,
      input: {
        ...validInput,
        keyDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
    "invalid_digest",
    ["input", "keyDigest"],
  );
});

test("every registered operation digest field rejects a cross-domain token", () => {
  const domains = Object.keys(V.digestDomains) as SharedStateDigestDomainV1[];
  for (const [domain, specification] of Object.entries(V.digestDomains)) {
    const wrongDomain = domains.find((candidate) => candidate !== domain);
    assert.ok(wrongDomain);
    for (const location of specification.operationFields) {
      const [rawOperation, section, ...relativePath] = location.split(".");
      const operation = rawOperation as SharedStateOperationV1;
      const envelope =
        section === "input"
          ? structuredClone(command(operation))
          : structuredClone(
              transactionResult(operation, {
                status: "committed",
                completeness: "complete",
                result: committedResults[operation],
              }),
            );
      assert.equal(typeof envelope, "object");
      assert.notEqual(envelope, null);
      let parent = envelope as Record<string, unknown>;
      const path = [section, ...relativePath];
      for (const segment of path.slice(0, -1)) {
        const nested = parent[segment];
        assert.equal(typeof nested, "object", location);
        assert.notEqual(nested, null, location);
        parent = nested as Record<string, unknown>;
      }
      const field = path[path.length - 1] as string;
      const current = parent[field];
      if (typeof current !== "string") {
        assert.fail(`${location} must resolve to a digest string`);
      }
      parent[field] = current.replace(`|${domain}|`, `|${wrongDomain}|`);

      if (section === "input") {
        expectError(
          parseSharedStateTransactionCommandV1(envelope),
          "digest_domain_mismatch",
          path,
        );
      } else {
        expectError(
          parseSharedStateTransactionResultV1(envelope),
          "digest_domain_mismatch",
          path,
        );
      }
    }
  }
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
          nonceDigest: digest(
            "security.replay.nonce",
            "security.replay",
            "1",
          ),
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

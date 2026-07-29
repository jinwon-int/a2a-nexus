/**
 * Pinned vocabulary for `a2a.shared-state.storage/v1`.
 *
 * Schemas, TypeScript unions, parsers, and tests derive their enum and reason
 * code values from this catalog. Adding or changing a value is therefore an
 * explicit contract-version decision rather than a backend implementation
 * detail.
 */

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export const SHARED_STATE_STORAGE_V1_VALUES = deepFreeze({
  versions: {
    contract: "a2a.shared-state.storage/v1",
    keyspace: "a2a.shared-state.keyspace/v1",
    metadata: 1,
    capabilities: 1,
    lifecycle: 1,
    openRequirements: 1,
    health: 1,
    declarations: 1,
    transaction: 1,
    operation: 1,
    drain: 1,
  },
  kinds: {
    metadata: "SharedStateStorageMetadataV1",
    capabilities: "SharedStateStorageCapabilitiesV1",
    lifecycle: "SharedStateStorageLifecycleV1",
    openRequirements: "SharedStateStorageOpenRequirementsV1",
    health: "SharedStateHealthProjectionV1",
    consistency: "SharedStateConsistencyDeclarationV1",
    completeness: "SharedStateCompletenessDeclarationV1",
    transactionCommand: "SharedStateTransactionCommandV1",
    transactionResult: "SharedStateTransactionResultV1",
    drainRequest: "SharedStateDrainRequestV1",
  },
  backendClasses: [
    "sqlite-single-writer",
    "shared",
  ],
  healthBackendClasses: [
    "legacy-process",
    "legacy-sqlite",
    "sqlite-single-writer",
    "shared",
  ],
  writerModels: [
    "single",
    "multi",
  ],
  durabilities: [
    "volatile",
    "durable",
  ],
  clockAuthorities: [
    "adapter-controlled",
    "backend-server",
  ],
  migrationStates: [
    "complete",
    "incomplete",
  ],
  topologyOwnershipRequirements: [
    "required",
    "not-required",
  ],
  lifecycleStates: [
    "new",
    "opening",
    "ready",
    "draining",
    "closed",
    "failed",
  ],
  lifecycleReasonCodes: [
    "open_requested",
    "drain_requested",
    "close_requested",
    "adapter_unavailable",
    "contract_version_mismatch",
    "schema_version_mismatch",
    "capability_downgrade",
    "unsafe_clock",
    "ownership_conflict",
    "lost_fence",
    "incomplete_migration",
    "drain_timeout",
    "ambiguous_write",
  ],
  configuredGrades: [
    "single-process",
    "single-writer-durable",
    "shared-state-ha",
  ],
  effectiveGrades: [
    "single-process",
    "single-writer-durable",
    "multi-process-unsupported",
    "shared-state-ha",
  ],
  readinessReasonCodes: [
    "ownership_conflict",
    "unsupported_topology",
    "adapter_unavailable",
    "contract_version_mismatch",
    "schema_version_mismatch",
    "capability_downgrade",
    "unsafe_clock",
    "incomplete_migration",
    "lost_fence",
    "draining",
    "closed",
    "adapter_failed",
  ],
  ownershipStates: [
    "held",
    "not-required",
    "conflict",
    "lost",
    "unknown",
  ],
  clockSafetyStates: [
    "safe",
    "unsafe",
    "unknown",
  ],
  primitiveSources: [
    "process",
    "adapter",
  ],
  continuityStates: [
    "reset",
    "preserved",
    "unknown",
  ],
  resetReasonCodes: [
    "process_start",
    "adapter_reopen",
    "operator_reset",
    "migration",
    "unknown",
  ],
  pressureBands: [
    "none",
    "low",
    "medium",
    "high",
    "critical",
    "unknown",
  ],
  ageBands: [
    "under-1m",
    "under-5m",
    "under-1h",
    "under-1d",
    "one-day-or-more",
    "unknown",
  ],
  consistencyModels: [
    "linearizable",
    "serializable",
    "strong",
    "monotonic-eventual",
  ],
  consistencyScopes: [
    "per-key",
    "per-stream",
    "per-event",
    "per-source-stream",
    "projection-batch",
  ],
  resultCompletenessStates: [
    "complete",
    "unavailable",
  ],
  graphCompletenessStates: [
    "complete",
    "incomplete",
    "unavailable",
  ],
  consistencyGuarantees: {
    replay: "linearizable-per-key",
    rateLimit: "linearizable-per-key",
    lease: "linearizable-per-key",
    idempotency: "linearizable-per-key",
    outbox: "serializable-per-stream",
    graphSource: "strong-per-source-stream",
    graphProjection: "monotonic-eventual",
  },
  completenessGuarantees: {
    graphQueries: "declared-per-result",
    negativeEvidenceRequires: "complete-checkpoint",
    healthProjection: "bounded-aggregates-only",
  },
  capabilityKeys: [
    "atomicCompareAndSet",
    "linearizablePerKey",
    "durableLogicalExpiry",
    "clockFloorProtection",
    "monotonicFencingTokens",
    "atomicIdempotencyDomainOutbox",
    "stablePerStreamOutboxOrdering",
    "durableOutboxAckState",
    "durableProjectionCheckpoints",
    "exactProjectionBatchRollback",
    "exclusiveSingletonOwnership",
  ],
  keyspace: {
    algorithm: "sha256",
    digestSeparator: "|",
    framingMagicHex: "4132412d53534b",
    framingVersion: 1,
    unicodeNormalization: "NFC",
    integerEncoding: "uint128-be",
    integerInput: "safe-number-or-canonical-decimal-string",
    byteInput: "even-length-hex-case-insensitive",
    byteCanonicalForm: "lowercase-hex",
  },
  keyComponentTypes: [
    "utf8",
    "uint",
    "bytes",
  ],
  keyComponentTypeTags: {
    utf8: 1,
    uint: 2,
    bytes: 3,
  },
  digestDomains: {
    "security.replay.requester-key": {
      components: [
        { field: "requesterId", type: "utf8" },
      ],
      operationFields: [
        "consumeReplayNonce.input.keyDigest",
      ],
    },
    "security.replay.nonce": {
      components: [
        { field: "nonce", type: "utf8" },
      ],
      operationFields: [
        "consumeReplayNonce.input.nonceDigest",
      ],
    },
    "security.rate-limit.bucket-key": {
      components: [
        { field: "principal", type: "utf8" },
        { field: "route", type: "utf8" },
      ],
      operationFields: [
        "reserveRateLimitCost.input.bucketKeyDigest",
      ],
    },
    "broker.lease.resource-key": {
      components: [
        { field: "resourceType", type: "utf8" },
        { field: "resourceId", type: "utf8" },
      ],
      operationFields: [
        "claimLease.input.resourceKeyDigest",
        "renewLease.input.resourceKeyDigest",
        "mutateWithFence.input.resourceKeyDigest",
        "releaseLease.input.resourceKeyDigest",
      ],
    },
    "broker.lease.owner-key": {
      components: [
        { field: "ownerId", type: "utf8" },
      ],
      operationFields: [
        "claimLease.input.ownerKeyDigest",
        "renewLease.input.ownerKeyDigest",
        "mutateWithFence.input.ownerKeyDigest",
        "releaseLease.input.ownerKeyDigest",
      ],
    },
    "broker.lease.attempt-key": {
      components: [
        { field: "resourceId", type: "utf8" },
        { field: "attemptNumber", type: "uint" },
      ],
      operationFields: [
        "claimLease.result.attemptKeyDigest",
        "renewLease.input.attemptKeyDigest",
        "mutateWithFence.input.attemptKeyDigest",
        "releaseLease.input.attemptKeyDigest",
      ],
    },
    "broker.lease.mutation": {
      components: [
        { field: "mutationKind", type: "utf8" },
        { field: "mutationBody", type: "bytes" },
      ],
      operationFields: [
        "mutateWithFence.input.mutationDigest",
      ],
    },
    "broker.idempotency.key": {
      components: [
        { field: "operationName", type: "utf8" },
        { field: "clientKey", type: "utf8" },
      ],
      operationFields: [
        "executeIdempotent.input.keyDigest",
      ],
    },
    "broker.idempotency.payload-fingerprint": {
      components: [
        { field: "payload", type: "bytes" },
      ],
      operationFields: [
        "executeIdempotent.input.payloadFingerprint",
      ],
    },
    "broker.idempotency.domain-mutation": {
      components: [
        { field: "mutationType", type: "utf8" },
        { field: "mutationBody", type: "bytes" },
      ],
      operationFields: [
        "executeIdempotent.input.effect.domainMutationDigest",
      ],
    },
    "broker.idempotency.outcome": {
      components: [
        { field: "outcomeType", type: "utf8" },
        { field: "outcomeBody", type: "bytes" },
      ],
      operationFields: [
        "executeIdempotent.result.outcomeDigest",
      ],
    },
    "broker.outbox.stream-key": {
      components: [
        { field: "streamType", type: "utf8" },
        { field: "streamId", type: "utf8" },
      ],
      operationFields: [
        "executeIdempotent.input.effect.outbox.streamKeyDigest",
        "appendOutbox.input.streamKeyDigest",
      ],
    },
    "broker.outbox.idempotency-key": {
      components: [
        { field: "producerId", type: "utf8" },
        { field: "clientKey", type: "utf8" },
      ],
      operationFields: [
        "appendOutbox.input.idempotencyKeyDigest",
      ],
    },
    "broker.outbox.event-key": {
      components: [
        { field: "eventId", type: "utf8" },
      ],
      operationFields: [
        "executeIdempotent.input.effect.outbox.eventKeyDigest",
        "appendOutbox.input.eventKeyDigest",
        "appendOutbox.result.eventKeyDigest",
        "updateOutboxReceipt.input.eventKeyDigest",
        "acknowledgeOutbox.input.eventKeyDigest",
      ],
    },
    "broker.outbox.payload": {
      components: [
        { field: "payload", type: "bytes" },
      ],
      operationFields: [
        "executeIdempotent.input.effect.outbox.payloadDigest",
        "appendOutbox.input.payloadDigest",
      ],
    },
    "broker.outbox.receipt-evidence": {
      components: [
        { field: "provider", type: "utf8" },
        { field: "evidence", type: "bytes" },
      ],
      operationFields: [
        "updateOutboxReceipt.input.receiptEvidenceDigest",
        "acknowledgeOutbox.input.receiptEvidenceDigest",
      ],
    },
    "broker.claim-graph.source-stream-key": {
      components: [
        { field: "sourceType", type: "utf8" },
        { field: "sourceId", type: "utf8" },
      ],
      operationFields: [
        "appendGraphSource.input.sourceStreamKeyDigest",
      ],
    },
    "broker.claim-graph.source-fact": {
      components: [
        { field: "nodeType", type: "utf8" },
        { field: "fact", type: "bytes" },
      ],
      operationFields: [
        "appendGraphSource.input.sourceFactDigest",
      ],
    },
    "broker.claim-graph.projection-batch-key": {
      components: [
        { field: "projectionVersion", type: "utf8" },
        { field: "batchId", type: "utf8" },
      ],
      operationFields: [
        "applyGraphProjectionBatch.input.batchKeyDigest",
        "rollbackGraphProjectionBatch.input.batchKeyDigest",
      ],
    },
    "broker.claim-graph.projection-batch": {
      components: [
        { field: "batch", type: "bytes" },
      ],
      operationFields: [
        "applyGraphProjectionBatch.input.batchDigest",
      ],
    },
    "broker.claim-graph.projection-inverse": {
      components: [
        { field: "inverse", type: "bytes" },
      ],
      operationFields: [
        "applyGraphProjectionBatch.input.inverseDigest",
        "rollbackGraphProjectionBatch.input.inverseDigest",
      ],
    },
    "broker.claim-graph.rollback-batch-key": {
      components: [
        { field: "projectionVersion", type: "utf8" },
        { field: "rollbackId", type: "utf8" },
      ],
      operationFields: [
        "rollbackGraphProjectionBatch.input.rollbackBatchKeyDigest",
      ],
    },
  },
  keyspaceErrorCodes: [
    "invalid_type",
    "unknown_field",
    "unknown_keyspace_version",
    "unknown_digest_domain",
    "invalid_namespace",
    "invalid_component_count",
    "unknown_component_field",
    "unknown_component_type",
    "component_order_mismatch",
    "component_type_mismatch",
    "empty_component",
    "component_too_large",
    "invalid_unicode",
    "invalid_bytes",
    "invalid_integer",
    "unsafe_integer",
    "invalid_digest",
    "digest_domain_mismatch",
    "digest_namespace_mismatch",
  ],
  operations: [
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
  ],
  transactionStatuses: [
    "committed",
    "rejected",
    "unavailable",
  ],
  leaseMutationKinds: [
    "checkpoint",
    "complete",
    "fail",
    "cancel",
  ],
  leaseReleaseKinds: [
    "release",
    "requeue",
  ],
  idempotentEffectKinds: [
    "domain-mutation-with-outbox",
  ],
  receiptStates: [
    "pending",
    "confirmed",
    "failed",
  ],
  acknowledgmentStates: [
    "unacknowledged",
    "acknowledged",
  ],
  graphNodeTypes: [
    "Entity",
    "Claim",
    "Source",
    "Artifact",
    "AgentRun",
    "Evaluation",
  ],
  operationConsistency: {
    consumeReplayNonce: {
      model: "linearizable",
      scope: "per-key",
    },
    reserveRateLimitCost: {
      model: "linearizable",
      scope: "per-key",
    },
    claimLease: {
      model: "linearizable",
      scope: "per-key",
    },
    renewLease: {
      model: "linearizable",
      scope: "per-key",
    },
    mutateWithFence: {
      model: "serializable",
      scope: "per-key",
    },
    releaseLease: {
      model: "linearizable",
      scope: "per-key",
    },
    executeIdempotent: {
      model: "serializable",
      scope: "per-key",
    },
    appendOutbox: {
      model: "serializable",
      scope: "per-stream",
    },
    updateOutboxReceipt: {
      model: "linearizable",
      scope: "per-event",
    },
    acknowledgeOutbox: {
      model: "linearizable",
      scope: "per-event",
    },
    appendGraphSource: {
      model: "strong",
      scope: "per-source-stream",
    },
    applyGraphProjectionBatch: {
      model: "serializable",
      scope: "projection-batch",
    },
    rollbackGraphProjectionBatch: {
      model: "serializable",
      scope: "projection-batch",
    },
  },
  operationDecisions: {
    consumeReplayNonce: [
      "accepted",
      "replay",
    ],
    reserveRateLimitCost: [
      "accepted",
      "rate_limited",
    ],
    claimLease: [
      "claimed",
    ],
    renewLease: [
      "renewed",
    ],
    mutateWithFence: [
      "applied",
    ],
    releaseLease: [
      "released",
    ],
    executeIdempotent: [
      "executed",
      "replayed",
    ],
    appendOutbox: [
      "appended",
      "replayed",
    ],
    updateOutboxReceipt: [
      "updated",
    ],
    acknowledgeOutbox: [
      "acknowledged",
      "already_acknowledged",
    ],
    appendGraphSource: [
      "appended",
      "replayed",
    ],
    applyGraphProjectionBatch: [
      "applied",
      "replayed",
    ],
    rollbackGraphProjectionBatch: [
      "rolled_back",
      "replayed",
    ],
  },
  operationRejectionReasonCodes: {
    consumeReplayNonce: [
      "invalid_expiry",
    ],
    reserveRateLimitCost: [
      "invalid_rate_policy",
    ],
    claimLease: [
      "claim_conflict",
      "version_conflict",
      "invalid_state_transition",
    ],
    renewLease: [
      "stale_fence",
      "lease_expired",
      "owner_mismatch",
      "version_conflict",
    ],
    mutateWithFence: [
      "stale_fence",
      "lease_expired",
      "owner_mismatch",
      "version_conflict",
      "invalid_state_transition",
    ],
    releaseLease: [
      "stale_fence",
      "owner_mismatch",
      "version_conflict",
      "invalid_state_transition",
    ],
    executeIdempotent: [
      "idempotency_conflict",
      "unknown_idempotency_outcome",
      "retention_policy_mismatch",
    ],
    appendOutbox: [
      "idempotency_conflict",
      "ordering_conflict",
      "retention_policy_mismatch",
    ],
    updateOutboxReceipt: [
      "event_not_found",
      "receipt_state_conflict",
      "invalid_state_transition",
    ],
    acknowledgeOutbox: [
      "event_not_found",
      "receipt_not_confirmed",
      "ack_state_conflict",
    ],
    appendGraphSource: [
      "source_sequence_conflict",
      "source_fact_conflict",
    ],
    applyGraphProjectionBatch: [
      "projection_batch_conflict",
      "checkpoint_conflict",
      "source_range_incomplete",
    ],
    rollbackGraphProjectionBatch: [
      "projection_batch_not_found",
      "projection_batch_conflict",
      "checkpoint_conflict",
    ],
  },
  unavailableReasonCodes: [
    "authority_unavailable",
    "lock_timeout",
    "lost_ownership",
    "ambiguous_commit",
    "unsafe_clock",
  ],
  parserErrorCodes: [
    "invalid_type",
    "invalid_value",
    "unknown_contract_version",
    "unknown_metadata_version",
    "unknown_lifecycle_version",
    "unknown_requirements_version",
    "unknown_health_version",
    "unknown_transaction_version",
    "unknown_operation_version",
    "unknown_drain_version",
    "unknown_field",
    "invalid_discriminant",
    "duplicate_value",
    "invalid_capability_combination",
    "capability_downgrade",
    "caller_clock_forbidden",
    "backend_command_forbidden",
    "sensitive_field_forbidden",
    "identity_health_field_forbidden",
    "operation_result_mismatch",
    "backend_class_mismatch",
    "writer_model_mismatch",
    "schema_version_mismatch",
    "clock_authority_mismatch",
    "migration_state_mismatch",
    "unknown_keyspace_version",
    "unknown_digest_domain",
    "invalid_digest",
    "digest_domain_mismatch",
    "digest_namespace_mismatch",
  ],
  limits: {
    implementationVersionLength: 128,
    namespaceLength: 96,
    opaqueTokenLength: 128,
    retentionVersionLength: 96,
    maxDurationMs: 31_536_000_000,
    maxRateLimit: 1_000_000_000,
    maxRateCost: 1_000_000,
    maxExpectedProcessCount: 10_000,
    maxHealthReasonCodes: 12,
    maxTransactionResultReasonCodes: 1,
    maxDecimalDigits: 40,
    maxKeyComponentBytes: 1024,
    maxKeyComponents: 8,
    maxDigestDomainLength: 96,
  },
} as const);

export type SharedStateStorageV1Values =
  typeof SHARED_STATE_STORAGE_V1_VALUES;

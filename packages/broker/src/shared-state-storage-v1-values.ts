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
  },
} as const);

export type SharedStateStorageV1Values =
  typeof SHARED_STATE_STORAGE_V1_VALUES;

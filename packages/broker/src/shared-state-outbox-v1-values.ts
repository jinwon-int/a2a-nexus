/**
 * Closed vocabulary and canonical registry for
 * `a2a.shared-state.outbox/v1`.
 *
 * The source inventory records the current durable-but-partial terminal outbox
 * exactly as it exists. The entries below are planned adapter stream
 * registrations. They do not connect current runtime code to the shared-state
 * contract and do not claim V1 conformance.
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

const STREAM_KEY_COMPONENTS = [
  {
    field: "streamType",
    type: "utf8",
    valueAuthority: "catalog-literal",
    literalValue: "broker-terminal-outbox",
  },
  {
    field: "streamId",
    type: "utf8",
    valueAuthority: "broker-authority-id",
    literalValue: null,
  },
] as const;

const PRUNE_PRECONDITIONS = [
  "receipt-confirmed-acknowledgment-proved",
  "consumer-checkpoint-safety-proved",
  "idempotency-retry-sources-provably-gone",
  "migration-and-rollback-preservation-proved",
  "separate-retention-approval-recorded",
] as const;

const MIGRATION_RULE =
  "preserve-namespace-exact-key-high-water-event-id-idempotency-receipt-ack-and-unacknowledged-rows";

export const SHARED_STATE_OUTBOX_V1_VALUES = deepFreeze({
  version: "a2a.shared-state.outbox/v1",
  storageContractVersion: "a2a.shared-state.storage/v1",
  keyspaceVersion: "a2a.shared-state.keyspace/v1",
  kind: "SharedStateOutboxCatalogV1",
  runtimeIntegration: "not-implemented",
  extensionPolicy: "forbidden",
  authorityStatuses: [
    "current-durable-partial",
  ],
  registrationStatuses: [
    "planned-adapter-stream",
  ],
  operations: [
    "appendOutbox",
    "updateOutboxReceipt",
    "acknowledgeOutbox",
  ],
  eventPurposes: [
    "task-terminal-notification",
    "cross-broker-projection-evidence",
    "cross-broker-operator-notification",
  ],
  currentOrderingAuthorities: [
    "broker-local-insertion-order-partial",
  ],
  currentSequenceAuthorities: [
    "task-event-process-id-or-zero-not-stream-sequence",
  ],
  currentReceiptAuthorities: [
    "terminal-outbox-object-and-hot-row",
  ],
  currentRetentionPostures: [
    "sqlite-unacknowledged-protected-memory-hard-cap-partial",
  ],
  streamKeyComponentTypes: [
    "utf8",
  ],
  streamKeyValueAuthorities: [
    "catalog-literal",
    "broker-authority-id",
  ],
  orderingScopes: [
    "total-within-exact-stream-key",
  ],
  sequenceAuthorities: [
    "adapter-allocated-per-exact-stream-key",
  ],
  monotonicityRules: [
    "unique-strictly-increasing-gaps-allowed",
  ],
  crossStreamOrderPostures: [
    "no-global-cross-stream-order",
  ],
  callerSequencePolicies: [
    "forbidden",
  ],
  eventIdAuthorities: [
    "task-id-status-completed-at",
    "cross-broker-projection-stable-id",
    "cross-broker-operator-row-stable-id",
  ],
  idempotencyBindings: [
    "same-key-and-payload-return-original-event-id-and-sequence",
  ],
  receiptAuthorities: [
    "consumer-receipt-evidence-compare-and-set",
    "projection-evidence-state-only",
  ],
  acknowledgmentAuthorities: [
    "receipt-confirmed-current-session-or-operator-visibility",
    "forbidden-projection-evidence",
  ],
  providerAcceptancePostures: [
    "pending-receipt-only-never-ack",
    "forbidden-on-projection-evidence",
  ],
  retentionPostures: [
    "unacknowledged-non-expiring-until-prune-proof",
  ],
  prunePolicies: [
    "receipt-confirmed-proof-gated",
    "v1-prune-forbidden",
  ],
  pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
  migrationRollbackPreservationRules: [
    MIGRATION_RULE,
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
  receiptEvidenceKinds: [
    "provider-sent",
    "provider-accepted",
    "current-session-visible",
    "operator-visible",
    "operator-confirmed",
    "delivery-failed",
    "projection-evidence",
  ],
  receiptPolicyVersions: [
    "terminal-notification-receipt.v1",
    "cross-broker-projection-evidence-receipt.v1",
  ],
  acknowledgmentPolicyVersions: [
    "terminal-notification-ack.v1",
    "cross-broker-projection-evidence-ack-forbidden.v1",
  ],
  retentionPolicyVersions: [
    "task-terminal-outbox-retention.v1",
    "cross-broker-projection-evidence-retention.v1",
    "cross-broker-operator-outbox-retention.v1",
  ],
  evidenceProperties: [
    "durable-row-authority",
    "producer",
    "stable-event-id",
    "idempotent-retry",
    "ordering-authority",
    "sequence-authority",
    "receipt-state",
    "ack-authority",
    "provider-acceptance-separation",
    "restart-continuity",
    "retention-dependency",
    "unacknowledged-protection",
    "partial-retention-limit",
  ],
  evaluationDecisions: [
    "registered",
    "retain",
    "prune-eligible",
    "same-stream",
    "different-streams",
    "original-binding",
  ],
  evaluationReasonCodes: [
    "registered_append_policy",
    "registered_receipt_policy",
    "registered_acknowledgment_policy",
    "retain_unacknowledged",
    "retain_provider_acceptance_not_ack",
    "retain_prune_proof_incomplete",
    "retain_v1_prune_forbidden",
    "prune_preconditions_satisfied",
    "same_stream_total_order",
    "cross_stream_no_order",
    "idempotent_retry_returns_original_binding",
  ],
  errorCodes: [
    "invalid_type",
    "unknown_field",
    "invalid_value",
    "unknown_catalog_version",
    "duplicate_authority",
    "duplicate_producer",
    "duplicate_registration",
    "unknown_authority",
    "unknown_producer",
    "authority_mapping_mismatch",
    "producer_mapping_mismatch",
    "incomplete_registry",
    "unsafe_registration",
    "invalid_namespace",
    "unknown_namespace",
    "unknown_event_purpose",
    "invalid_stream_key",
    "stream_key_shape_mismatch",
    "stream_key_component_mismatch",
    "invalid_stream_key_component",
    "stream_key_digest_mismatch",
    "ordering_scope_mismatch",
    "caller_sequence_forbidden",
    "invalid_retention_policy_version",
    "unknown_retention_policy_version",
    "retention_policy_mismatch",
    "invalid_receipt_policy_version",
    "unknown_receipt_policy_version",
    "receipt_policy_mismatch",
    "invalid_acknowledgment_policy_version",
    "unknown_acknowledgment_policy_version",
    "acknowledgment_policy_mismatch",
    "receipt_transition_mismatch",
    "acknowledgment_forbidden",
    "provider_acceptance_not_ack",
    "acknowledgment_evidence_mismatch",
    "invalid_retention_evaluation",
    "invalid_retry_binding",
    "idempotent_retry_conflict",
  ],
  limits: {
    namespaceLength: 96,
    registrationIdLength: 128,
    authorityIdLength: 96,
    producerIdLength: 96,
    policyVersionLength: 96,
    sourcePathLength: 256,
    sourceSymbolLength: 192,
    streamComponentValueLength: 128,
    maxSourceRefs: 12,
    maxEvidenceProperties: 13,
    maxProducers: 8,
    maxPrunePreconditions: 8,
    maxDecimalDigits: 40,
  },
  catalog: {
    kind: "SharedStateOutboxCatalogV1",
    catalogVersion: "a2a.shared-state.outbox/v1",
    storageContractVersion: "a2a.shared-state.storage/v1",
    keyspaceVersion: "a2a.shared-state.keyspace/v1",
    runtimeIntegration: "not-implemented",
    extensionPolicy: "forbidden",
    defaultStreamNamespace: null,
    defaultOrderingScope: null,
    globalOrdering: false,
    authorities: [
      {
        authorityId: "terminal-task-event-outbox",
        status: "current-durable-partial",
        currentStorageAuthority:
          "TerminalTaskEventOutbox plus broker_terminal_outbox",
        currentStreamKeyDerivation:
          "implicit broker-local TerminalTaskEventOutbox instance",
        currentOrderingAuthority:
          "broker-local-insertion-order-partial",
        currentSequenceAuthority:
          "task-event-process-id-or-zero-not-stream-sequence",
        currentReceiptAuthority:
          "terminal-outbox-object-and-hot-row",
        currentRetentionPosture:
          "sqlite-unacknowledged-protected-memory-hard-cap-partial",
        sourceRefs: [
          {
            path: "packages/broker/src/core/terminal-event-outbox.ts",
            symbol: "export class TerminalTaskEventOutbox",
            proves: [
              "producer",
              "stable-event-id",
              "idempotent-retry",
              "ordering-authority",
              "receipt-state",
              "ack-authority",
              "provider-acceptance-separation",
              "restart-continuity",
              "partial-retention-limit",
            ],
          },
          {
            path: "packages/broker/src/core/store.ts",
            symbol: "CREATE TABLE IF NOT EXISTS broker_terminal_outbox",
            proves: [
              "durable-row-authority",
              "restart-continuity",
            ],
          },
          {
            path: "packages/broker/src/core/store.ts",
            symbol:
              "SELECT payload FROM broker_terminal_outbox ORDER BY created_at ASC, id ASC",
            proves: [
              "ordering-authority",
              "sequence-authority",
            ],
          },
          {
            path:
              "packages/broker/src/core/store-hot-retention-planning.ts",
            symbol:
              "export function planTerminalOutboxRetentionFromRecords(",
            proves: [
              "retention-dependency",
              "unacknowledged-protection",
            ],
          },
        ],
        producers: [
          {
            producerId: "task-terminal-event",
            eventPurpose: "task-terminal-notification",
            eventIdAuthority: "task-id-status-completed-at",
            sourceRefs: [
              {
                path:
                  "packages/broker/src/core/terminal-event-outbox.ts",
                symbol:
                  "export function formatTerminalTaskEventId(taskId: string, status: TaskStatus, completedAt: string): string",
                proves: [
                  "stable-event-id",
                  "idempotent-retry",
                ],
              },
              {
                path: "packages/broker/src/core/broker.ts",
                symbol:
                  "this.terminalTaskEventOutbox.enqueue(taskEvent, task)",
                proves: [
                  "producer",
                ],
              },
              {
                path: "packages/broker/src/core/event-buffer.ts",
                symbol: "private nextId = 0",
                proves: [
                  "sequence-authority",
                ],
              },
            ],
          },
          {
            producerId: "cross-broker-projection-evidence",
            eventPurpose: "cross-broker-projection-evidence",
            eventIdAuthority: "cross-broker-projection-stable-id",
            sourceRefs: [
              {
                path:
                  "packages/broker/src/core/terminal-event-outbox.ts",
                symbol:
                  "enqueueCrossBrokerProjection(projection: CrossBrokerTerminalBriefProjection)",
                proves: [
                  "producer",
                  "stable-event-id",
                  "idempotent-retry",
                  "ack-authority",
                ],
              },
              {
                path:
                  "packages/broker/src/core/cross-broker-terminal-brief.ts",
                symbol:
                  "return `${record.parentRoundId}::${record.originBrokerId}::${childKey}`",
                proves: [
                  "stable-event-id",
                  "idempotent-retry",
                ],
              },
            ],
          },
          {
            producerId: "cross-broker-operator-row",
            eventPurpose: "cross-broker-operator-notification",
            eventIdAuthority: "cross-broker-operator-row-stable-id",
            sourceRefs: [
              {
                path:
                  "packages/broker/src/core/terminal-event-outbox.ts",
                symbol: "private enqueueCrossBrokerOperatorFacingRow(",
                proves: [
                  "producer",
                  "stable-event-id",
                  "idempotent-retry",
                  "ack-authority",
                ],
              },
            ],
          },
        ],
      },
    ],
    entries: [
      {
        registrationId:
          "broker.terminal-outbox/task-terminal-notification",
        status: "planned-adapter-stream",
        namespace: "broker.terminal-outbox",
        eventPurpose: "task-terminal-notification",
        authorityId: "terminal-task-event-outbox",
        producerId: "task-terminal-event",
        streamKeyComponents: STREAM_KEY_COMPONENTS,
        orderingScope: "total-within-exact-stream-key",
        sequenceAuthority: "adapter-allocated-per-exact-stream-key",
        monotonicityRule: "unique-strictly-increasing-gaps-allowed",
        crossStreamOrder: "no-global-cross-stream-order",
        callerSequencePolicy: "forbidden",
        eventIdAuthority: "task-id-status-completed-at",
        idempotencyBinding:
          "same-key-and-payload-return-original-event-id-and-sequence",
        receiptPolicyVersion: "terminal-notification-receipt.v1",
        receiptAuthority: "consumer-receipt-evidence-compare-and-set",
        acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
        acknowledgmentAuthority:
          "receipt-confirmed-current-session-or-operator-visibility",
        providerAcceptancePosture: "pending-receipt-only-never-ack",
        retentionPolicyVersion: "task-terminal-outbox-retention.v1",
        retentionPosture:
          "unacknowledged-non-expiring-until-prune-proof",
        prunePolicy: "receipt-confirmed-proof-gated",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule: MIGRATION_RULE,
      },
      {
        registrationId:
          "broker.terminal-outbox/cross-broker-projection-evidence",
        status: "planned-adapter-stream",
        namespace: "broker.terminal-outbox",
        eventPurpose: "cross-broker-projection-evidence",
        authorityId: "terminal-task-event-outbox",
        producerId: "cross-broker-projection-evidence",
        streamKeyComponents: STREAM_KEY_COMPONENTS,
        orderingScope: "total-within-exact-stream-key",
        sequenceAuthority: "adapter-allocated-per-exact-stream-key",
        monotonicityRule: "unique-strictly-increasing-gaps-allowed",
        crossStreamOrder: "no-global-cross-stream-order",
        callerSequencePolicy: "forbidden",
        eventIdAuthority: "cross-broker-projection-stable-id",
        idempotencyBinding:
          "same-key-and-payload-return-original-event-id-and-sequence",
        receiptPolicyVersion:
          "cross-broker-projection-evidence-receipt.v1",
        receiptAuthority: "projection-evidence-state-only",
        acknowledgmentPolicyVersion:
          "cross-broker-projection-evidence-ack-forbidden.v1",
        acknowledgmentAuthority: "forbidden-projection-evidence",
        providerAcceptancePosture:
          "forbidden-on-projection-evidence",
        retentionPolicyVersion:
          "cross-broker-projection-evidence-retention.v1",
        retentionPosture:
          "unacknowledged-non-expiring-until-prune-proof",
        prunePolicy: "v1-prune-forbidden",
        pruneEligibilityPreconditions: [],
        migrationRollbackPreservationRule: MIGRATION_RULE,
      },
      {
        registrationId:
          "broker.terminal-outbox/cross-broker-operator-notification",
        status: "planned-adapter-stream",
        namespace: "broker.terminal-outbox",
        eventPurpose: "cross-broker-operator-notification",
        authorityId: "terminal-task-event-outbox",
        producerId: "cross-broker-operator-row",
        streamKeyComponents: STREAM_KEY_COMPONENTS,
        orderingScope: "total-within-exact-stream-key",
        sequenceAuthority: "adapter-allocated-per-exact-stream-key",
        monotonicityRule: "unique-strictly-increasing-gaps-allowed",
        crossStreamOrder: "no-global-cross-stream-order",
        callerSequencePolicy: "forbidden",
        eventIdAuthority: "cross-broker-operator-row-stable-id",
        idempotencyBinding:
          "same-key-and-payload-return-original-event-id-and-sequence",
        receiptPolicyVersion: "terminal-notification-receipt.v1",
        receiptAuthority: "consumer-receipt-evidence-compare-and-set",
        acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
        acknowledgmentAuthority:
          "receipt-confirmed-current-session-or-operator-visibility",
        providerAcceptancePosture: "pending-receipt-only-never-ack",
        retentionPolicyVersion:
          "cross-broker-operator-outbox-retention.v1",
        retentionPosture:
          "unacknowledged-non-expiring-until-prune-proof",
        prunePolicy: "receipt-confirmed-proof-gated",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule: MIGRATION_RULE,
      },
    ],
  },
} as const);

export type SharedStateOutboxV1Values =
  typeof SHARED_STATE_OUTBOX_V1_VALUES;

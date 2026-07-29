/**
 * Closed vocabulary and canonical registry for
 * `a2a.shared-state.idempotency/v1`.
 *
 * The registry describes planned adapter namespaces only. Its source inventory
 * points at current durable-but-partial authorities; it does not connect those
 * authorities to the shared-state contract or claim runtime conformance.
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

const PRUNE_PRECONDITIONS = [
  "retry-sources-provably-gone",
  "outbox-effects-provably-gone",
  "retained-effects-provably-gone",
  "migration-and-rollback-preservation-proved",
] as const;

export const SHARED_STATE_IDEMPOTENCY_V1_VALUES = deepFreeze({
  version: "a2a.shared-state.idempotency/v1",
  storageContractVersion: "a2a.shared-state.storage/v1",
  timeVersion: "a2a.shared-state.time/v1",
  kind: "SharedStateIdempotencyCatalogV1",
  runtimeIntegration: "not-implemented",
  extensionPolicy: "forbidden",
  authorityStatuses: [
    "current-durable-partial",
  ],
  registrationStatuses: [
    "planned-adapter-namespace",
  ],
  effectKinds: [
    "domain-mutation-with-outbox",
  ],
  effectClasses: [
    "externally-visible",
    "irreversible",
    "reversible",
    "non-effecting",
  ],
  durabilities: [
    "durable",
    "volatile",
  ],
  expiryPostures: [
    "non-expiring-until-prune-proof",
    "time-bounded",
  ],
  retryHorizonDependencies: [
    "task-create-request-retries",
    "wake-dispatch-retries",
    "worker-terminal-and-recovery-retries",
    "live-approval-action-retries",
    "authorized-source-delivery-retries",
    "projection-delivery-retries",
  ],
  effectHorizonDependencies: [
    "task-record-audit-and-descendant-effects",
    "wake-decision-and-runtime-effect",
    "task-terminal-outbox-and-retry-lineage",
    "approval-consumption-and-authorized-effect",
    "source-lineage-and-ledger",
    "projection-and-terminal-outbox",
  ],
  requiredEffectDependencies: [
    "outbox",
    "retained-effect",
    "outbox-and-retained-effect",
  ],
  pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
  migrationRollbackPreservationRules: [
    "preserve-key-fingerprint-outcome-retention-and-effect-links",
  ],
  logicalExpiryBoundaryKinds: [
    "idempotency-explicit-retention",
  ],
  evidenceProperties: [
    "durable-key-or-state",
    "payload-fingerprint",
    "stable-outcome",
    "domain-mutation",
    "outbox-effect",
    "restart-continuity",
    "retry-suppression",
  ],
  evaluationDecisions: [
    "registered",
    "non-expiring",
    "time-bounded",
  ],
  evaluationReasonCodes: [
    "registered_policy",
    "non_expiring_until_prune_proof",
    "explicit_time_v1_boundary_accepted",
  ],
  errorCodes: [
    "invalid_type",
    "unknown_field",
    "invalid_value",
    "unknown_catalog_version",
    "duplicate_namespace",
    "duplicate_retention_policy_version",
    "duplicate_authority",
    "unknown_authority",
    "authority_mapping_mismatch",
    "unsafe_expiry_policy",
    "expiry_boundary_requirement_mismatch",
    "invalid_namespace",
    "unknown_namespace",
    "invalid_retention_policy_version",
    "unknown_retention_policy_version",
    "retention_policy_mismatch",
    "effect_policy_mismatch",
    "expiry_boundary_required",
    "expiry_boundary_forbidden",
    "invalid_expiry_boundary",
  ],
  limits: {
    namespaceLength: 96,
    retentionPolicyVersionLength: 96,
    authorityIdLength: 96,
    sourcePathLength: 256,
    sourceSymbolLength: 160,
    maxSourceRefs: 8,
    maxEvidenceProperties: 8,
    maxPrunePreconditions: 8,
  },
  catalog: {
    kind: "SharedStateIdempotencyCatalogV1",
    catalogVersion: "a2a.shared-state.idempotency/v1",
    storageContractVersion: "a2a.shared-state.storage/v1",
    timeVersion: "a2a.shared-state.time/v1",
    runtimeIntegration: "not-implemented",
    extensionPolicy: "forbidden",
    defaultRetentionPolicyVersion: null,
    authorities: [
      {
        authorityId: "task-create-by-id",
        status: "current-durable-partial",
        plannedNamespace: "broker.task.create",
        sourceRefs: [
          {
            path: "packages/broker/src/core/broker.ts",
            symbol: "createTask(request: CreateTaskRequest): TaskRecord",
            proves: [
              "durable-key-or-state",
              "domain-mutation",
              "retry-suppression",
            ],
          },
          {
            path: "packages/broker/src/core/store.ts",
            symbol: "CREATE TABLE IF NOT EXISTS broker_tasks",
            proves: [
              "restart-continuity",
            ],
          },
        ],
      },
      {
        authorityId: "accepted-task-wake",
        status: "current-durable-partial",
        plannedNamespace: "broker.task.wake",
        sourceRefs: [
          {
            path: "packages/broker/src/core/broker.ts",
            symbol: "planAcceptedTaskWake(taskId: string, request: TaskWakePlanRequest): TaskWakePlanResult",
            proves: [
              "durable-key-or-state",
              "stable-outcome",
              "domain-mutation",
              "retry-suppression",
            ],
          },
          {
            path: "packages/broker/src/core/store-schemas.ts",
            symbol: "export const taskWakeSchema",
            proves: [
              "restart-continuity",
            ],
          },
          {
            path: "packages/broker/src/core/store.ts",
            symbol: "CREATE TABLE IF NOT EXISTS broker_tasks",
            proves: [
              "durable-key-or-state",
            ],
          },
        ],
      },
      {
        authorityId: "task-terminal-mutation",
        status: "current-durable-partial",
        plannedNamespace: "broker.task.terminal",
        sourceRefs: [
          {
            path: "packages/broker/src/core/broker-task-terminal.ts",
            symbol: "export function completeTask(",
            proves: [
              "durable-key-or-state",
              "domain-mutation",
              "retry-suppression",
            ],
          },
          {
            path: "packages/broker/src/core/broker-task-terminal.ts",
            symbol: "export function failTask(",
            proves: [
              "domain-mutation",
              "retry-suppression",
            ],
          },
          {
            path: "packages/broker/src/core/broker-task-cancellation.ts",
            symbol: "export function cancelTask(",
            proves: [
              "domain-mutation",
              "retry-suppression",
            ],
          },
          {
            path: "packages/broker/src/core/broker.ts",
            symbol: "this.terminalTaskEventOutbox.enqueue(taskEvent, task)",
            proves: [
              "outbox-effect",
            ],
          },
          {
            path: "packages/broker/src/core/store.ts",
            symbol: "CREATE TABLE IF NOT EXISTS broker_terminal_outbox",
            proves: [
              "restart-continuity",
            ],
          },
        ],
      },
      {
        authorityId: "live-approval-consumption",
        status: "current-durable-partial",
        plannedNamespace: "broker.live-approval.consume",
        sourceRefs: [
          {
            path: "packages/broker/src/core/store.ts",
            symbol: "consumeLiveApprovalKey(key: string, consumedAt: string): boolean",
            proves: [
              "durable-key-or-state",
              "stable-outcome",
              "retry-suppression",
              "restart-continuity",
            ],
          },
          {
            path: "packages/broker/src/core/store.ts",
            symbol: "CREATE TABLE IF NOT EXISTS broker_live_approval_consumptions",
            proves: [
              "domain-mutation",
            ],
          },
        ],
      },
      {
        authorityId: "review-lineage-source-ledger",
        status: "current-durable-partial",
        plannedNamespace: "broker.review-lineage.source",
        sourceRefs: [
          {
            path: "packages/broker/src/core/review-lineage-observation-store.ts",
            symbol: "payloadFingerprint: string",
            proves: [
              "payload-fingerprint",
            ],
          },
          {
            path: "packages/broker/src/core/review-lineage-observation-store.ts",
            symbol: "idempotency_key TEXT PRIMARY KEY",
            proves: [
              "durable-key-or-state",
              "stable-outcome",
              "domain-mutation",
              "retry-suppression",
              "restart-continuity",
            ],
          },
        ],
      },
      {
        authorityId: "cross-broker-terminal-brief-ingest",
        status: "current-durable-partial",
        plannedNamespace: "broker.terminal-brief.cross-broker-ingest",
        sourceRefs: [
          {
            path: "packages/broker/src/core/cross-broker-terminal-brief.ts",
            symbol: "const sourceDigest = digestProjection(normalized)",
            proves: [
              "payload-fingerprint",
              "stable-outcome",
              "domain-mutation",
              "retry-suppression",
            ],
          },
          {
            path: "packages/broker/src/core/broker.ts",
            symbol: "this.terminalTaskEventOutbox.enqueueCrossBrokerProjection(result.record)",
            proves: [
              "outbox-effect",
            ],
          },
          {
            path: "packages/broker/src/core/broker.ts",
            symbol: "this.crossBrokerTerminalBriefs.restore(snapshot.crossBrokerTerminalBriefs ?? [])",
            proves: [
              "durable-key-or-state",
              "restart-continuity",
            ],
          },
        ],
      },
    ],
    entries: [
      {
        namespace: "broker.task.create",
        status: "planned-adapter-namespace",
        retentionPolicyVersion: "task-create-effects.v1",
        authorityId: "task-create-by-id",
        effectKind: "domain-mutation-with-outbox",
        effectClass: "externally-visible",
        durability: "durable",
        expiryPosture: "non-expiring-until-prune-proof",
        retryHorizonDependency: "task-create-request-retries",
        effectHorizonDependency: "task-record-audit-and-descendant-effects",
        requiredEffectDependency: "outbox-and-retained-effect",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule:
          "preserve-key-fingerprint-outcome-retention-and-effect-links",
        logicalExpiryBoundaryKind: null,
      },
      {
        namespace: "broker.task.wake",
        status: "planned-adapter-namespace",
        retentionPolicyVersion: "task-wake-effects.v1",
        authorityId: "accepted-task-wake",
        effectKind: "domain-mutation-with-outbox",
        effectClass: "externally-visible",
        durability: "durable",
        expiryPosture: "non-expiring-until-prune-proof",
        retryHorizonDependency: "wake-dispatch-retries",
        effectHorizonDependency: "wake-decision-and-runtime-effect",
        requiredEffectDependency: "outbox-and-retained-effect",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule:
          "preserve-key-fingerprint-outcome-retention-and-effect-links",
        logicalExpiryBoundaryKind: null,
      },
      {
        namespace: "broker.task.terminal",
        status: "planned-adapter-namespace",
        retentionPolicyVersion: "task-terminal-effects.v1",
        authorityId: "task-terminal-mutation",
        effectKind: "domain-mutation-with-outbox",
        effectClass: "externally-visible",
        durability: "durable",
        expiryPosture: "non-expiring-until-prune-proof",
        retryHorizonDependency: "worker-terminal-and-recovery-retries",
        effectHorizonDependency: "task-terminal-outbox-and-retry-lineage",
        requiredEffectDependency: "outbox-and-retained-effect",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule:
          "preserve-key-fingerprint-outcome-retention-and-effect-links",
        logicalExpiryBoundaryKind: null,
      },
      {
        namespace: "broker.live-approval.consume",
        status: "planned-adapter-namespace",
        retentionPolicyVersion: "live-approval-effects.v1",
        authorityId: "live-approval-consumption",
        effectKind: "domain-mutation-with-outbox",
        effectClass: "irreversible",
        durability: "durable",
        expiryPosture: "non-expiring-until-prune-proof",
        retryHorizonDependency: "live-approval-action-retries",
        effectHorizonDependency: "approval-consumption-and-authorized-effect",
        requiredEffectDependency: "outbox-and-retained-effect",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule:
          "preserve-key-fingerprint-outcome-retention-and-effect-links",
        logicalExpiryBoundaryKind: null,
      },
      {
        namespace: "broker.review-lineage.source",
        status: "planned-adapter-namespace",
        retentionPolicyVersion: "review-lineage-effects.v1",
        authorityId: "review-lineage-source-ledger",
        effectKind: "domain-mutation-with-outbox",
        effectClass: "externally-visible",
        durability: "durable",
        expiryPosture: "non-expiring-until-prune-proof",
        retryHorizonDependency: "authorized-source-delivery-retries",
        effectHorizonDependency: "source-lineage-and-ledger",
        requiredEffectDependency: "outbox-and-retained-effect",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule:
          "preserve-key-fingerprint-outcome-retention-and-effect-links",
        logicalExpiryBoundaryKind: null,
      },
      {
        namespace: "broker.terminal-brief.cross-broker-ingest",
        status: "planned-adapter-namespace",
        retentionPolicyVersion: "cross-broker-terminal-brief-effects.v1",
        authorityId: "cross-broker-terminal-brief-ingest",
        effectKind: "domain-mutation-with-outbox",
        effectClass: "externally-visible",
        durability: "durable",
        expiryPosture: "non-expiring-until-prune-proof",
        retryHorizonDependency: "projection-delivery-retries",
        effectHorizonDependency: "projection-and-terminal-outbox",
        requiredEffectDependency: "outbox-and-retained-effect",
        pruneEligibilityPreconditions: PRUNE_PRECONDITIONS,
        migrationRollbackPreservationRule:
          "preserve-key-fingerprint-outcome-retention-and-effect-links",
        logicalExpiryBoundaryKind: null,
      },
    ],
  },
} as const);

export type SharedStateIdempotencyV1Values =
  typeof SHARED_STATE_IDEMPOTENCY_V1_VALUES;

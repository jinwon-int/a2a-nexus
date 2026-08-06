import { z } from "zod";

import { CURRENT_BROKER_STATE_VERSION } from "./store-contracts.js";

const TASK_ORIGIN_VALUES = ["github", "api", "sessions_send", "operator", "unknown"] as const;

/**
 * Bounded compatibility mapping (#1504, routed from #1725 finding 4):
 * snapshots persisted by older brokers can carry `taskOrigin` values outside
 * the current enum, and one such row made the whole snapshot parse throw —
 * which took `/health` down to 500 while `/workers` kept serving from hot
 * tables. Map any present-but-unrecognized value onto the existing
 * `"unknown"` sentinel instead of rejecting the snapshot. Bounded to this
 * single field: unrecognized values are NOT blanket-allowed, and every
 * other enum keeps failing closed.
 */
const taskOriginSchema = z.preprocess(
  (value) =>
    typeof value === "string" && !(TASK_ORIGIN_VALUES as readonly string[]).includes(value)
      ? "unknown"
      : value,
  z.enum(TASK_ORIGIN_VALUES).optional(),
);

export const partyRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

export const workspaceRefSchema = z
  .object({
    nodeId: z.string().min(1),
    workspaceId: z.string().min(1),
    pathHint: z.string().optional(),
    branch: z.string().optional(),
    strategyId: z.string().optional(),
  })
  .passthrough();

export const exchangeViaObjectSchema = z
  .object({
    transport: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .passthrough();

export const exchangeViaSchema = z.union([
  exchangeViaObjectSchema,
  z.string().min(1).transform((transport) => ({ transport })),
]);

export const exchangeStateSchema = z
  .object({
    id: z.string().min(1),
    requester: partyRefSchema,
    target: partyRefSchema,
    targetNodeId: z.string().min(1),
    assignedWorkerId: z.string().min(1).optional(),
    message: z.string(),
    maxTurns: z.number(),
    intent: z.string().min(1),
    status: z.string().min(1),
    currentDecision: z.string().min(1).optional(),
    rootMessageId: z.string(),
    latestMessageId: z.string(),
    messageCount: z.number(),
    lastMessageAt: z.string(),
    activeTaskId: z.string().min(1).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const exchangeMessageSchema = z
  .object({
    id: z.string().min(1),
    exchangeId: z.string().min(1),
    kind: z.string().min(1),
    message: z.string(),
    requester: partyRefSchema.optional(),
    actor: partyRefSchema.optional(),
    via: exchangeViaSchema.optional(),
    decision: z.string().min(1).optional(),
    targetNodeId: z.string().min(1).optional(),
    assignedWorkerId: z.string().min(1).optional(),
    parentMessageId: z.string().min(1).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const taskValidationPayloadSchema = z
  .object({
    nodeId: z.string().min(1).optional(),
    kind: z.string().min(1),
    verdict: z.string().min(1),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    artifactIds: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .passthrough();

export const taskApplyPayloadSchema = z
  .object({
    workspace: workspaceRefSchema.optional(),
    artifactIds: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .passthrough();

export const taskResultSchema = z
  .object({
    summary: z.string().optional(),
    note: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
    validation: taskValidationPayloadSchema.optional(),
    apply: taskApplyPayloadSchema.optional(),
  })
  .passthrough();

export const taskErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const taskCancellationSchema = z
  .object({
    requestedAt: z.string(),
    requestedBy: z.string().min(1),
    kind: z.enum(["operator_cancel", "superseded"]).optional(),
    reason: z.string().optional(),
    sourceTaskId: z.string().min(1).optional(),
    supersededByTaskId: z.string().min(1).optional(),
    supersededByPrUrl: z.string().min(1).optional(),
    roundId: z.string().min(1).optional(),
  })
  .passthrough();

export const taskApprovalSchema = z
  .object({
    approvalId: z.string().min(1),
    approvedAt: z.string(),
    approvedBy: z.string().min(1),
    actorRole: z.string().optional(),
    requesterRole: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const taskApprovalOutcomeSchema = z
  .object({
    status: z.enum(["approved", "rejected", "expired", "canceled"]),
    approvalId: z.string().min(1),
    decidedAt: z.string(),
    decidedBy: z.string().min(1),
    actorRole: z.string().optional(),
    requesterRole: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const taskPolicyContextSchema = z
  .object({
    requiresApproval: z.boolean().optional(),
    liveImpact: z.boolean().optional(),
    targetEnvironment: z.string().min(1).optional(),
    injectedKnowledge: z
      .object({
        source: z.string().min(1),
        asOf: z.string().min(1),
        hints: z.array(z.string().min(1)),
      })
      .optional(),
  })
  .passthrough();


export const taskWakeSchema = z
  .object({
    status: z.enum(["planned", "scheduled", "skipped", "failed"]),
    wakeKey: z.string().min(1),
    idempotencyKey: z.string().min(1),
    targetSessionKey: z.string().min(1),
    targetNodeId: z.string().min(1).optional(),
    waitRunId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    coalesced: z.boolean().optional(),
    runtimeRunId: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    message: z.string().optional(),
    plannedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    decidedAt: z.string().min(1).optional(),
    replayCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const taskLaneAssignmentSchema = z
  .object({
    version: z.literal("fast-lane.v1"),
    mode: z.literal("shadow"),
    decision: z.enum(["fast", "full"]),
    reasonCodes: z.array(z.enum([
      "all_fast_conditions_met",
      "requester_lane_facts_present",
      "intent_not_analyze",
      "mode_missing",
      "mode_not_read_only_analysis",
      "write_or_implementation_marker_present",
      "worker_assignment_conflict",
      "round_marker_present",
      "fanout_marker_present",
      "multi_worker_marker_present",
      "delegated_workflow_marker_present",
      "worker_mode_missing",
      "worker_not_persistent",
      "policy_decision_missing",
      "policy_decision_unknown",
      "policy_requires_approval",
      "policy_denied",
      "approval_marker_present",
      "sensitive_marker_present",
      "live_marker_present",
      "external_send_marker_present",
      "credential_access_marker_present",
    ])).min(1),
  })
  .strict();

export const taskSchema = z
  .object({
    id: z.string().min(1),
    exchangeId: z.string().min(1).optional(),
    parentTaskId: z.string().min(1).optional(),
    intent: z.string().min(1),
    requester: partyRefSchema,
    target: partyRefSchema,
    workspace: workspaceRefSchema.optional(),
    message: z.string().optional(),
    proposalId: z.string().min(1).optional(),
    artifactIds: z.array(z.string()).optional(),
    assignedWorkerId: z.string().min(1).optional(),
    via: exchangeViaSchema.optional(),
    policyContext: taskPolicyContextSchema.optional(),
    createdAt: z.string(),
    status: z.string().min(1),
    targetNodeId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    laneAssignment: taskLaneAssignmentSchema.optional(),
    updatedAt: z.string(),
    claimedAt: z.string().optional(),
    completedAt: z.string().optional(),
    claimedBy: z.string().min(1).optional(),
    result: taskResultSchema.optional(),
    error: taskErrorSchema.optional(),
    cancellation: taskCancellationSchema.optional(),
    approval: taskApprovalSchema.optional(),
    approvalOutcome: taskApprovalOutcomeSchema.optional(),
    requeueCount: z.number().int().nonnegative().optional(),
    lastHeartbeatAt: z.string().optional(),
    attemptId: z.string().min(1).optional(),
    wake: taskWakeSchema.optional(),
    taskOrigin: taskOriginSchema,
  })
  .passthrough();

export const proposalSchema = z
  .object({
    id: z.string().min(1),
    source: partyRefSchema,
    target: partyRefSchema,
    sourceNodeId: z.string().min(1),
    targetNodeId: z.string().min(1),
    kind: z.string().min(1),
    summary: z.string().min(1),
    rationale: z.string().optional(),
    workspace: workspaceRefSchema,
    patchText: z.string().optional(),
    parameterPayload: z.record(z.string(), z.unknown()).optional(),
    artifactIds: z.array(z.string()),
    status: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const artifactSchema = z
  .object({
    id: z.string().min(1),
    proposalId: z.string().min(1),
    kind: z.string().min(1),
    uri: z.string().min(1),
    contentType: z.string().optional(),
    sizeBytes: z.number().optional(),
    summary: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

export const validationSchema = z
  .object({
    id: z.string().min(1),
    proposalId: z.string().min(1),
    nodeId: z.string().min(1),
    kind: z.string().min(1),
    verdict: z.string().min(1),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    artifactIds: z.array(z.string()),
    note: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

export const auditEventSchema = z
  .object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    action: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    proposalId: z.string().min(1).optional(),
    note: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

export const workerCapabilitiesSchema = z
  .object({
    canAnalyze: z.boolean(),
    canBackfill: z.boolean(),
    canPatchWorkspace: z.boolean(),
    canPromoteLive: z.boolean(),
    workspaceIds: z.array(z.string()),
    environments: z.array(z.string()),
  })
  .passthrough();

export const workerSchema = z
  .object({
    nodeId: z.string().min(1),
    role: z.string().min(1),
    displayName: z.string().optional(),
    brokerUrl: z.string().optional(),
    capabilities: workerCapabilitiesSchema,
    metadata: z.record(z.string(), z.string()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastSeenAt: z.string(),
  })
  .passthrough();

export const tombstoneSchema = z
  .object({
    taskId: z.string().min(1),
    terminalStatus: z.string().min(1),
    tombstoneReason: z.string().min(1),
    durationMs: z.number(),
    requeueCount: z.number(),
    error: taskErrorSchema.optional(),
    result: taskResultSchema.optional(),
    tombstonedAt: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const terminalOutboxEventSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("task.terminal"),
    taskEventId: z.number().int().nonnegative(),
    payload: z
      .object({
        taskId: z.string().min(1),
        status: z.enum(["succeeded", "failed", "canceled", "blocked"]),
        worker: z.string().optional(),
        repo: z.string().optional(),
        issue: z.number().int().nonnegative().optional(),
        terminalBriefTitle: z.string().optional(),
        prUrl: z.string().url().optional(),
        doneUrl: z.string().url().optional(),
        blockUrl: z.string().url().optional(),
        testSummary: z.string().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
        completedAt: z.string().optional(),
      })
      .passthrough(),
    createdAt: z.string(),
    ack: z
      .object({
        status: z.literal("receipt_confirmed"),
        evidence: z.enum(["current_session_visible", "operator_visible", "operator_confirmed", "provider_delivery_receipt"]),
        acknowledgedAt: z.string(),
        receiptId: z.string().optional(),
        note: z.string().optional(),
      })
      .passthrough()
      .optional(),
    receipt: z
      .object({
        status: z.enum(["accepted", "started", "produced", "provider_sent", "provider_accepted", "current_session_visible", "operator_visible", "timed_out", "stale", "failed", "sent", "provider_delivered_if_known"]),
        updatedAt: z.string(),
        evidence: z.enum(["current_session_visible", "operator_visible", "operator_confirmed", "provider_delivery_receipt"]).optional(),
        receiptId: z.string().optional(),
        note: z.string().optional(),
      })
      .passthrough()
      .optional(),
    deliveredAt: z.string().optional(),
    attempts: z.number().int().nonnegative(),
  })
  .passthrough();

export const crossBrokerTerminalBriefProjectionSchema = z
  .object({
    id: z.string().min(1),
    parentRoundId: z.string().min(1),
    originBrokerId: z.string().min(1),
    brokerOfRecordId: z.string().min(1).optional(),
    childTaskId: z.string().min(1).optional(),
    childRunId: z.string().min(1).optional(),
    childWorkerId: z.string().min(1).optional(),
    status: z.enum(["succeeded", "failed", "canceled", "blocked"]),
    summary: z.string().optional(),
    taskBrief: z.string().optional(),
    terminalBriefTitle: z.string().optional(),
    evidenceUrl: z.string().url().optional(),
    completedAt: z.string(),
    emittedAt: z.string(),
    receivedAt: z.string(),
    sourceDigest: z.string().min(1),
    replayCount: z.number().int().nonnegative(),
    parentRoundTotal: z.number().int().positive().optional(),
    parentRoundOrder: z.number().int().positive().optional(),
    ack: z
      .object({
        decision: z.enum(["accepted", "duplicate_replay"]),
        terminalAck: z.literal(false),
        reason: z.string(),
        updatedAt: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const pushNotificationConfigSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    url: z.string().min(1),
    token: z.string().optional(),
    authentication: z
      .object({
        schemes: z.array(z.string()).optional(),
        credentials: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const waveStageGateSchema = z.union([
  z.object({ type: z.literal("quorum"), minSubstantive: z.number().int().nonnegative() }).passthrough(),
  z.object({ type: z.literal("approval") }).passthrough(),
  z.object({ type: z.literal("manual") }).passthrough(),
]);

const waveStageSchema = z
  .object({
    id: z.string().min(1),
    dispatch: z.object({ manifestRef: z.string().min(1) }).passthrough().optional(),
    gate: waveStageGateSchema,
    onGateFail: z.enum(["halt", "retry-once"]).optional(),
  })
  .passthrough();

export const wavePlanSchema = z
  .object({
    wavePlanId: z.string().min(1),
    stages: z.array(waveStageSchema),
    state: z.enum(["draft", "running", "stage_ready", "halted", "completed", "aborted"]),
    currentStage: z.number().int().nonnegative(),
    retriedStages: z.array(z.number().int().nonnegative()).default([]),
  })
  .passthrough();

export const persistedWavePlanSchema = z
  .object({
    plan: wavePlanSchema,
    updatedAt: z.string().min(1),
    stalledNotifiedAt: z.string().min(1).optional(),
  })
  .passthrough();

const reviewLineageBudgetSchema = z
  .object({
    kind: z.literal("ReviewLineageBudgetV1"),
    maxWallClockSeconds: z.number().int().nonnegative(),
    maxCorrectionGenerations: z.number().int().nonnegative(),
    maxReviewerRuns: z.number().int().nonnegative(),
    maxReviewerReplacements: z.number().int().nonnegative(),
    repeatedFindingThreshold: z.number().int().positive(),
    onExhaustion: z.literal("blocked_needs_operator"),
  })
  .passthrough();

const reviewFindingSchema = z
  .object({
    findingId: z.string().min(1),
    criterionRef: z.string().min(1),
    evidenceRefs: z.array(z.string()),
    severity: z.enum(["critical", "major", "minor"]),
    category: z.enum([
      "correctness",
      "security",
      "regression",
      "spec_ambiguity",
      "scope_drift",
      "style",
      "preference",
      "design",
      "other",
    ]),
    blocking: z.boolean(),
    introducedAtHead: z.string().min(1),
    firstSeenAtHead: z.string().min(1),
    resolvedAtHead: z.string().nullable(),
    disposition: z.enum([
      "open",
      "resolved",
      "reopened",
      "overruled_by_finalizer",
    ]),
    signature: z.string().min(1),
  })
  .passthrough();

const appealRequestSchema = z
  .object({
    kind: z.literal("AppealRequestV1"),
    appealId: z.string().min(1),
    lineageId: z.string().min(1),
    findingId: z.string().min(1),
    requestedBy: z.string().min(1),
    requesterRole: z.enum(["author", "operator"]),
    reason: z.string().min(1),
    requestedAt: z.string().min(1),
  })
  .passthrough();

const finalizerDispositionSchema = z
  .object({
    kind: z.literal("FinalizerDispositionV1"),
    dispositionId: z.string().min(1),
    appealId: z.string().min(1),
    lineageId: z.string().min(1),
    findingId: z.string().min(1),
    finalizerId: z.string().min(1),
    disposition: z.enum(["upheld", "overruled_by_finalizer"]),
    justification: z.string().min(1),
    decidedAt: z.string().min(1),
  })
  .passthrough();

const appealDispositionStateSchema = z
  .object({
    kind: z.literal("AppealDispositionStateV1"),
    lineageId: z.string().min(1),
    finalizerOwnerId: z.string().min(1).nullable(),
    requests: z.array(appealRequestSchema),
    dispositions: z.array(finalizerDispositionSchema),
  })
  .passthrough();

export const reviewLineageRecordSchema = z
  .object({
    kind: z.literal("a2a.review-lineage.v1"),
    lineageId: z.string().min(1),
    mode: z.enum(["off", "record", "enforce"]),
    state: z.enum([
      "reviewing_initial",
      "correction_pending",
      "reviewing_resolution",
      "passed",
      "blocked_needs_operator",
      "intent_conflict",
      "canceled",
    ]),
    contract: z
      .object({
        kind: z.literal("IntentContractV1"),
        lineageId: z.string().min(1),
        goal: z.string(),
        nonGoals: z.array(z.string()),
        invariants: z.array(z.string()),
        acceptanceCriteria: z.array(
          z.object({
            id: z.string().min(1),
            text: z.string(),
          }),
        ),
        declaredPaths: z.object({
          allowed: z.array(z.string()),
          forbidden: z.array(z.string()).optional(),
        }),
        baseSha: z.string().min(1),
        headSha: z.string().min(1),
        createdAt: z.string().min(1),
        intentHash: z.string().min(1),
      })
      .passthrough(),
    budget: reviewLineageBudgetSchema,
    ledger: z
      .object({
        kind: z.literal("FindingLedgerV1"),
        ledgerId: z.string().min(1),
        lineageId: z.string().min(1),
        findings: z.array(reviewFindingSchema),
      })
      .passthrough(),
    appeal: appealDispositionStateSchema.optional(),
    counters: z.object({
      correctionGenerations: z.number().int().nonnegative(),
      reviewerRuns: z.number().int().nonnegative(),
      reviewerReplacements: z.number().int().nonnegative(),
      findingsNew: z.number().int().nonnegative(),
      findingsReopened: z.number().int().nonnegative(),
      findingsResolved: z.number().int().nonnegative(),
      repeatedSignatureHits: z.number().int().nonnegative(),
      goalpostRejections: z.number().int().nonnegative(),
      scopeDriftRejections: z.number().int().nonnegative(),
    }),
    currentHeadSha: z.string().min(1),
    currentDiffHash: z.string().nullable(),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    terminalReason: z
      .enum([
        "budget_wall_clock",
        "budget_correction_generations",
        "budget_reviewer_runs",
        "repeated_findings",
        "intent_drift",
        "scope_drift",
        "operator_cancel",
      ])
      .nullable(),
    unresolvedSignatures: z.record(
      z.string(),
      z.number().int().nonnegative(),
    ),
  })
  .passthrough()
  .transform((record) => ({
    ...record,
    // Phase 5 adds the durable appeal ledger. Older snapshots cannot contain
    // dispositions because the appeal API did not exist, so an empty ledger is
    // the only lossless backward-compatible projection.
    appeal: record.appeal ?? {
      kind: "AppealDispositionStateV1" as const,
      lineageId: record.lineageId,
      finalizerOwnerId: null,
      requests: [],
      dispositions: [],
    },
  }));

export const brokerSnapshotSchema = z
  .object({
    version: z.number().int().nonnegative().optional().default(CURRENT_BROKER_STATE_VERSION),
    exchanges: z.array(exchangeStateSchema).optional().default([]),
    exchangeMessages: z.array(exchangeMessageSchema).optional().default([]),
    proposals: z.array(proposalSchema).optional().default([]),
    artifacts: z.array(artifactSchema).optional().default([]),
    validations: z.array(validationSchema).optional().default([]),
    auditEvents: z.array(auditEventSchema).optional().default([]),
    workers: z.array(workerSchema).optional().default([]),
    tasks: z.array(taskSchema).optional().default([]),
    tombstones: z.array(tombstoneSchema).optional().default([]),
    terminalOutbox: z.array(terminalOutboxEventSchema).optional().default([]),
    crossBrokerTerminalBriefs: z.array(crossBrokerTerminalBriefProjectionSchema).optional().default([]),
    wavePlans: z.array(persistedWavePlanSchema).optional().default([]),
    reviewLineages: z.array(reviewLineageRecordSchema).optional().default([]),
    pushNotificationConfigs: z.array(pushNotificationConfigSchema).optional(),
  })
  .passthrough();

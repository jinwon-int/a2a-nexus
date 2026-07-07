import { z } from "zod";

import { CURRENT_BROKER_STATE_VERSION } from "./store-contracts.js";

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
    taskOrigin: z.enum(["github", "api", "sessions_send", "operator", "unknown"]).optional(),
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
    pushNotificationConfigs: z.array(pushNotificationConfigSchema).optional(),
  })
  .passthrough();

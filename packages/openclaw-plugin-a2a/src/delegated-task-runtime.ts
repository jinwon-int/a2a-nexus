import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createConfiguredA2ABrokerClient,
  shouldEnableWakeOnTask,
  shouldUseStandaloneBrokerSessionsSendAdapter,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../config.js";
import {
  buildBrokerCreateTaskRequestFromOpenClaw,
  type A2ABrokerTaskSseEvent,
  type A2ABrokerTaskRecord,
} from "../standalone-broker-client.js";
import type { A2AWakeGuardState, A2AWakeRuntimePort } from "./wake-layer.js";
import {
  runA2AWakeAfterTaskAcceptance,
  type A2AWakeAfterAcceptanceOptions,
} from "./wake-envelope.js";

type PluginRuntime = OpenClawPluginApi["runtime"];

// Local mirror of the canonical core wait-run seam shape from
// `openclaw/plugin-sdk/core` (see `AgentWaitRunRuntime`). Mirrored here so this
// plugin compiles against older SDK type bundles that have not yet picked up
// the seam — the production code reads the runtime structurally.
export type AgentWaitRunStatus = "pending" | "ok" | "error" | "timeout";

export type AgentWaitRunRecord = {
  runId: string;
  status: AgentWaitRunStatus;
  error?: string;
  replyText?: string;
  startedAt?: number;
  endedAt?: number;
};

export type AgentWaitRunRuntime = {
  create: (params?: { runId?: string; startedAt?: number }) => AgentWaitRunRecord;
  get: (runId: string) => AgentWaitRunRecord | null;
  wait: (params: { runId: string; timeoutMs: number }) => Promise<AgentWaitRunRecord | null>;
  resolve: (params: {
    runId: string;
    replyText?: string;
    startedAt?: number;
    endedAt?: number;
  }) => AgentWaitRunRecord;
  fail: (params: {
    runId: string;
    status?: Extract<AgentWaitRunStatus, "error" | "timeout">;
    error?: string;
    replyText?: string;
    startedAt?: number;
    endedAt?: number;
  }) => AgentWaitRunRecord;
  cancel: (params: {
    runId: string;
    error?: string;
    replyText?: string;
    startedAt?: number;
    endedAt?: number;
  }) => AgentWaitRunRecord;
  clear: (runId: string) => boolean;
};

export type SessionRunCancelTarget = {
  kind: "session_run";
  sessionKey: string;
  runId: string;
};

export type SessionRunCancelHandlerResult = {
  status: "cancelled" | "ignored";
  reason?: string;
};

export type RegisterDelegatedSessionRunCancelHandler = (
  target: SessionRunCancelTarget,
  handler: (
    target: SessionRunCancelTarget,
  ) => SessionRunCancelHandlerResult | Promise<SessionRunCancelHandlerResult>,
) => () => void;

type SessionsSendHookEvent = {
  sessionKey: string;
  target?: {
    sessionKey?: string;
    displayKey?: string;
  };
  message: string;
  task?: {
    intent?: string;
    instructions?: string;
    constraints?: {
      timeoutSeconds?: number;
      maxPingPongTurns?: number;
    };
    runtime?: {
      waitRunId?: string;
      roundOneReply?: string;
      announceTimeoutMs?: number;
      maxPingPongTurns?: number;
      cancelTarget?: {
        kind?: string;
        sessionKey?: string;
        runId?: string;
      };
    };
    requester?: {
      sessionKey?: string;
      channel?: string;
    };
    correlationId?: string;
    parentRunId?: string;
  };
  rawParams?: unknown;
};

type SessionsSendHookResult =
  | { handled: false; reason?: string }
  | { handled: true; mode: "direct"; result: Record<string, unknown> };

type RawBrokerClient = ReturnType<typeof createConfiguredA2ABrokerClient>;
type BrokerClientFactory = (config: A2ABrokerAdapterPluginRuntimeConfig) => RawBrokerClient;

type RuntimeDeps = {
  createBrokerClient?: BrokerClientFactory;
  registerCancelHandler?: RegisterDelegatedSessionRunCancelHandler;
  randomId?: () => string;
  wake?: A2AWakeAfterAcceptanceOptions;
  wakeRuntime?: A2AWakeRuntimePort;
};

type ActiveDelegatedTask = {
  taskId: string;
  waitRunId: string;
  broker: RawBrokerClient;
  acceptedTask: A2ABrokerTaskRecord;
  event: SessionsSendHookEvent;
  waitTimeoutMs: number;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  monitorAbort: AbortController;
  monitorPromise: Promise<void>;
  disposeCancelHandler?: () => void;
  finalTask?: A2ABrokerTaskRecord;
  timeoutMessage?: string;
  cancelReason?: string;
};

type AnnounceFlowTask = Pick<
  ActiveDelegatedTask,
  "acceptedTask" | "event" | "announceTimeoutMs" | "maxPingPongTurns" | "finalTask"
>;

type AnnounceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

type HumanGateDelivery = {
  status: "blocked";
  mode: "human_approval_required";
  deliveryId: string;
  taskId: string;
  reason: string;
  policyContext?: NonNullable<A2ABrokerTaskRecord["policyContext"]>;
};

type PendingAnnounceDelivery = {
  status: "pending";
  mode: "announce";
};

type AnnounceDelivery = PendingAnnounceDelivery | HumanGateDelivery;

export type BlockedAnnounceDeliveryStatus =
  | "blocked"
  | "delivering"
  | "delivered"
  | "rejected"
  | "skipped"
  | "failed";

export type BlockedAnnounceDeliveryAuditEvent = {
  eventId: string;
  deliveryId: string;
  taskId: string;
  type:
    | "blocked"
    | "approved"
    | "approval_rejected"
    | "delivered"
    | "skipped"
    | "failed"
    | "duplicate_approval";
  timestamp: string;
  approvalId?: string;
  approvedBy?: string;
  summary: string;
};

export type BlockedAnnounceDeliverySnapshot = {
  deliveryId: string;
  taskId: string;
  waitRunId: string;
  mode: "human_approval_required";
  status: BlockedAnnounceDeliveryStatus;
  reason: string;
  targetSessionKey: string;
  targetDisplayKey?: string;
  requesterSessionKey?: string;
  requesterChannel?: string;
  correlationId?: string;
  policyContext?: NonNullable<A2ABrokerTaskRecord["policyContext"]>;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvalId?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  deliveredAt?: string;
  attempts: number;
  audit: BlockedAnnounceDeliveryAuditEvent[];
};

export type BlockedAnnounceDeliveryResumeSignal = {
  deliveryId?: string;
  taskId?: string;
  approved: true;
  approvalId: string;
  approvedBy?: string;
  approvedAt?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type BlockedAnnounceDeliveryTerminalSignal = {
  deliveryId?: string;
  taskId?: string;
  outcome: "rejected" | "expired" | "canceled";
  approvalId?: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

type BlockedAnnounceDeliveryRecord = BlockedAnnounceDeliverySnapshot & {
  announceTask: AnnounceFlowTask;
};

export type BlockedAnnounceDeliveryResumeResult =
  | { status: "delivered"; delivery: BlockedAnnounceDeliverySnapshot }
  | { status: "skipped"; delivery: BlockedAnnounceDeliverySnapshot; reason: string }
  | { status: "duplicate"; delivery: BlockedAnnounceDeliverySnapshot; reason: string }
  | { status: "not_found"; reason: string }
  | { status: "rejected"; reason: string };

type AnnounceFlowResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string };

const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
const REPLY_SKIP_TOKEN = "REPLY_SKIP";
const REPLY_HISTORY_LIMIT = 50;
const NESTED_LANE = "nested";

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function normalizeFinitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : undefined;
}

function readRawTaskId(rawParams: unknown): string | undefined {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return undefined;
  }
  return normalizeOptionalString((rawParams as Record<string, unknown>).taskId);
}

function normalizeSessionRunCancelTarget(
  value:
    | {
        kind?: string;
        sessionKey?: string;
        runId?: string;
      }
    | undefined,
): SessionRunCancelTarget | undefined {
  if (value?.kind !== "session_run") {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(value.sessionKey);
  const runId = normalizeOptionalString(value.runId);
  if (!sessionKey || !runId) {
    return undefined;
  }
  return { kind: "session_run", sessionKey, runId };
}

function readReplyFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["reply", "text", "message", "content", "summary", "note"]) {
    const found = readReplyFromUnknown(record[key]);
    if (found) {
      return found;
    }
  }
  return undefined;
}


function getHumanGatePolicyContext(
  brokerTask: A2ABrokerTaskRecord | undefined,
): NonNullable<A2ABrokerTaskRecord["policyContext"]> | undefined {
  const policyContext = brokerTask?.policyContext;
  if (!policyContext) {
    return undefined;
  }
  if (
    policyContext.requiresApproval === true ||
    policyContext.liveImpact === true ||
    policyContext.targetEnvironment === "live"
  ) {
    return policyContext;
  }
  return undefined;
}

function readTaskPayloadString(task: A2ABrokerTaskRecord | undefined, key: string): string | undefined {
  const payload = task?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return normalizeOptionalString((payload as Record<string, unknown>)[key]);
}

function deriveBlockedAnnounceDeliveryId(taskId: string, waitRunId?: string): string {
  const suffix = normalizeOptionalString(waitRunId) ?? taskId;
  return `announce:${taskId}:${suffix}`;
}

function blockedAnnounceDeliveryIdFor(
  brokerTask: A2ABrokerTaskRecord | undefined,
  waitRunId?: string,
): string | undefined {
  if (!brokerTask?.id) {
    return undefined;
  }
  return deriveBlockedAnnounceDeliveryId(
    brokerTask.id,
    waitRunId ?? readTaskPayloadString(brokerTask, "waitRunId"),
  );
}

function buildAnnounceDelivery(
  brokerTask: A2ABrokerTaskRecord | undefined,
  waitRunId?: string,
): AnnounceDelivery {
  const policyContext = getHumanGatePolicyContext(brokerTask);
  if (!policyContext) {
    return { status: "pending", mode: "announce" };
  }
  const deliveryId = blockedAnnounceDeliveryIdFor(brokerTask, waitRunId) ?? "announce:unknown";
  return {
    status: "blocked",
    mode: "human_approval_required",
    deliveryId,
    taskId: brokerTask?.id ?? "unknown",
    reason: "live-impact task requires explicit human approval before external announce",
    policyContext,
  };
}

function buildBrokerApprovalResumeSignal(
  brokerTask: A2ABrokerTaskRecord | undefined,
): Omit<BlockedAnnounceDeliveryResumeSignal, "deliveryId" | "taskId"> | undefined {
  const approval = brokerTask?.approval;
  const approvalOutcome = brokerTask?.approvalOutcome;
  const taskId = brokerTask?.id;
  if (approvalOutcome && approvalOutcome.status !== "approved") {
    return undefined;
  }
  if (!approval?.approvalId || !taskId) {
    return undefined;
  }
  return {
    approved: true,
    approvalId: approval.approvalId,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    reason: approval.reason ?? "broker approval released blocked external announce delivery",
    metadata: {
      source: "broker.task.approved",
      taskId,
      ...(approval.actorRole ? { actorRole: approval.actorRole } : {}),
      ...(approval.requesterRole ? { requesterRole: approval.requesterRole } : {}),
    },
  };
}

function buildBrokerApprovalTerminalSignal(
  brokerTask: A2ABrokerTaskRecord | undefined,
): Omit<BlockedAnnounceDeliveryTerminalSignal, "deliveryId" | "taskId"> | undefined {
  const outcome = brokerTask?.approvalOutcome;
  const taskId = brokerTask?.id;
  if (!outcome || outcome.status === "approved" || !taskId) {
    return undefined;
  }
  return {
    outcome: outcome.status,
    approvalId: outcome.approvalId,
    decidedBy: outcome.decidedBy,
    decidedAt: outcome.decidedAt,
    reason: outcome.reason ?? `broker approval ${outcome.status}`,
    metadata: {
      source: "broker.task.approval_outcome",
      taskId,
      ...(outcome.actorRole ? { actorRole: outcome.actorRole } : {}),
      ...(outcome.requesterRole ? { requesterRole: outcome.requesterRole } : {}),
    },
  };
}

function cloneBlockedSnapshot(record: BlockedAnnounceDeliveryRecord): BlockedAnnounceDeliverySnapshot {
  const { announceTask: _announceTask, audit, ...snapshot } = record;
  return {
    ...snapshot,
    audit: audit.map((entry) => ({ ...entry })),
  };
}

function extractReplyFromBrokerTask(task: A2ABrokerTaskRecord | undefined): string | undefined {
  if (!task) {
    return undefined;
  }
  return (
    readReplyFromUnknown(task.result?.output) ??
    normalizeOptionalString(task.result?.summary) ??
    normalizeOptionalString(task.result?.note) ??
    readReplyFromUnknown(task.payload)
  );
}

function extractErrorMessage(task: A2ABrokerTaskRecord | undefined): string {
  return (
    normalizeOptionalString(task?.approvalOutcome?.reason) ??
    normalizeOptionalString(task?.error?.message) ??
    normalizeOptionalString(task?.error?.code) ??
    `broker task ${task?.status ?? "failed"}`
  );
}

function buildTerminalBrokerTaskFromEvent(
  task: ActiveDelegatedTask,
  event: A2ABrokerTaskSseEvent,
): A2ABrokerTaskRecord | undefined {
  if (!event.data.final) {
    return undefined;
  }
  const projection = event.data.task;
  const status = mapTerminalProjectionStatus(event.data.reason, projection.status.state);
  if (!status) {
    return undefined;
  }

  const metadata = projection.metadata;
  if (status === "succeeded" && !hasOperatorVisibleTerminalReceipt(metadata)) {
    return undefined;
  }
  const safeEvidence = pickTerminalEventEvidence(metadata);
  const statusMessage = readProjectionStatusMessage(projection.status.message);
  const explicitSummary = readStringEvidence(safeEvidence, "summary") ?? readStringEvidence(safeEvidence, "testSummary");
  const fallbackSummary = status === "succeeded"
    ? buildEmptyTerminalReportSummary({ taskId: projection.id || task.taskId, evidence: safeEvidence })
    : undefined;
  const summary = statusMessage ?? explicitSummary ?? fallbackSummary;
  const timestamp = projection.status.timestamp || task.acceptedTask.updatedAt;

  return {
    ...task.acceptedTask,
    id: projection.id || task.taskId,
    status,
    updatedAt: timestamp,
    ...(status === "succeeded" ? { completedAt: timestamp } : {}),
    ...(status === "succeeded" && summary
      ? { result: { summary, output: safeEvidence } }
      : status === "succeeded" && Object.keys(safeEvidence).length > 0
        ? { result: { output: safeEvidence } }
        : {}),
    ...(status !== "succeeded"
      ? {
          error: {
            message: summary ?? `broker task ${status}`,
            ...(readStringEvidence(safeEvidence, "blockUrl")
              ? { details: { blockUrl: readStringEvidence(safeEvidence, "blockUrl") } }
              : {}),
          },
        }
      : {}),
    payload: {
      ...task.acceptedTask.payload,
      terminalEvent: {
        ...(event.id ? { id: event.id } : {}),
        name: event.name,
        reason: event.data.reason,
        final: true,
        taskId: projection.id,
        status,
        timestamp,
        ...safeEvidence,
      },
    },
  };
}

function mapTerminalProjectionStatus(
  reason: A2ABrokerTaskSseEvent["data"]["reason"],
  state: A2ABrokerTaskSseEvent["data"]["task"]["status"]["state"],
): A2ABrokerTaskRecord["status"] | undefined {
  switch (reason) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "dead_lettered":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      break;
  }
  switch (state) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return undefined;
  }
}

function readProjectionStatusMessage(
  message: A2ABrokerTaskSseEvent["data"]["task"]["status"]["message"],
): string | undefined {
  if (!message) {
    return undefined;
  }
  return normalizeOptionalString(
    message.parts
      .map((part) => part.text)
      .filter((text) => text.trim())
      .join("\n"),
  );
}

function pickTerminalEventEvidence(metadata: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of [
    "worker",
    "repo",
    "issue",
    "prUrl",
    "doneUrl",
    "blockUrl",
    "testSummary",
    "summary",
    "startedAt",
    "completedAt",
    "updatedAt",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      output[key] = value.trim();
    } else if (key === "issue" && typeof value === "number" && Number.isFinite(value)) {
      output[key] = value;
    }
  }
  return output;
}

function readStringEvidence(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildEmptyTerminalReportSummary(params: {
  taskId: string;
  evidence: Record<string, unknown>;
}): string {
  const lines = [
    `Broker task ${params.taskId} succeeded, but no result/report body was provided.`,
    "Empty-state report: no actionable summary was propagated by the worker.",
    readStringEvidence(params.evidence, "repo") ? `Repo: ${readStringEvidence(params.evidence, "repo")}` : undefined,
    typeof params.evidence.issue === "number" && Number.isFinite(params.evidence.issue)
      ? `Issue: ${params.evidence.issue}`
      : undefined,
    readStringEvidence(params.evidence, "prUrl") ? `PR: ${readStringEvidence(params.evidence, "prUrl")}` : undefined,
    readStringEvidence(params.evidence, "doneUrl") ? `Done: ${readStringEvidence(params.evidence, "doneUrl")}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

const OPERATOR_VISIBLE_TERMINAL_RECEIPT_PROJECTIONS = new Set([
  "current_session_visible",
  "manual_operator_receipt",
]);

function hasOperatorVisibleTerminalReceipt(metadata: Record<string, unknown>): boolean {
  for (const value of readTerminalReceiptProjectionCandidates(metadata)) {
    if (OPERATOR_VISIBLE_TERMINAL_RECEIPT_PROJECTIONS.has(value)) {
      return true;
    }
  }
  return false;
}

function readTerminalReceiptProjectionCandidates(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => readTerminalReceiptProjectionCandidates(item));
  }
  const record = value as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of [
    "terminalAckProjection",
    "ackProjection",
    "receiptProjection",
    "operatorVisibleProjection",
    "projection",
    "kind",
    "type",
    "source",
  ]) {
    const candidate = readStringEvidence(record, key);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  for (const key of ["terminalAck", "ack", "receipt", "operatorReceipt", "visibility", "evidence"]) {
    candidates.push(...readTerminalReceiptProjectionCandidates(record[key]));
  }
  return candidates;
}

function isTimeoutTask(task: A2ABrokerTaskRecord | undefined): boolean {
  const code = normalizeOptionalString(task?.error?.code)?.toLowerCase();
  return code === "timeout" || code === "timed_out" || code === "broker_timeout";
}

function buildReplyContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  currentRole: "requester" | "target";
  turn: number;
  maxTurns: number;
}): string {
  const currentLabel =
    params.currentRole === "requester" ? "Agent 1 (requester)" : "Agent 2 (target)";
  return [
    "Agent-to-agent reply step:",
    `Current agent: ${currentLabel}.`,
    `Turn ${params.turn} of ${params.maxTurns}.`,
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel ? `Agent 1 (requester) channel: ${params.requesterChannel}.` : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
    `If you want to stop the ping-pong, reply exactly "${REPLY_SKIP_TOKEN}".`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAnnounceContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply?: string;
}): string {
  return [
    "Agent-to-agent announce step:",
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel ? `Agent 1 (requester) channel: ${params.requesterChannel}.` : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
    `Original request: ${params.originalMessage}`,
    params.roundOneReply ? `Round 1 reply: ${params.roundOneReply}` : "Round 1 reply: (not available).",
    params.latestReply ? `Latest reply: ${params.latestReply}` : "Latest reply: (not available).",
    `If you want to remain silent, reply exactly "${ANNOUNCE_SKIP_TOKEN}".`,
    "Any other reply will be posted to the target channel.",
    "After this reply, the agent-to-agent conversation is over.",
  ]
    .filter(Boolean)
    .join("\n");
}

function readLatestAssistantReplyText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const role = normalizeOptionalString((candidate as Record<string, unknown>).role);
    if (role !== "assistant") {
      continue;
    }
    const content = (candidate as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          return undefined;
        }
        const record = part as Record<string, unknown>;
        return record.type === "text" ? normalizeOptionalString(record.text) : undefined;
      })
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

async function readSessionReply(
  runtime: PluginRuntime,
  sessionKey: string,
): Promise<string | undefined> {
  const result = await runtime.subagent.getSessionMessages({
    sessionKey,
    limit: REPLY_HISTORY_LIMIT,
  });
  return readLatestAssistantReplyText(Array.isArray(result.messages) ? result.messages : []);
}

async function runSubagentStep(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  randomId: () => string;
}): Promise<string | undefined> {
  const started = await params.runtime.subagent.run({
    sessionKey: params.sessionKey,
    message: params.message,
    extraSystemPrompt: params.extraSystemPrompt,
    lane: NESTED_LANE,
    deliver: false,
    idempotencyKey: params.randomId(),
  });
  const waited = await params.runtime.subagent.waitForRun({
    runId: started.runId,
    timeoutMs: params.timeoutMs,
  });
  if (waited.status !== "ok") {
    return undefined;
  }
  return await readSessionReply(params.runtime, params.sessionKey);
}

async function resolveAnnounceTarget(
  runtime: PluginRuntime,
  sessionKey: string,
): Promise<AnnounceTarget | null> {
  try {
    const storePath = runtime.agent.session.resolveStorePath();
    const store = runtime.agent.session.loadSessionStore(storePath);
    const entry = store?.[sessionKey] as Record<string, unknown> | undefined;
    const deliveryContext =
      entry?.deliveryContext &&
      typeof entry.deliveryContext === "object" &&
      !Array.isArray(entry.deliveryContext)
        ? (entry.deliveryContext as Record<string, unknown>)
        : undefined;
    const channel =
      normalizeOptionalString(deliveryContext?.channel) ??
      normalizeOptionalString(entry?.lastChannel);
    const to =
      normalizeOptionalString(deliveryContext?.to) ?? normalizeOptionalString(entry?.lastTo);
    const accountId =
      normalizeOptionalString(deliveryContext?.accountId) ??
      normalizeOptionalString(entry?.lastAccountId);
    const threadId =
      normalizeOptionalString(deliveryContext?.threadId) ??
      normalizeOptionalString(entry?.lastThreadId);
    if (!channel || !to) {
      return null;
    }
    return {
      channel,
      to,
      ...(accountId ? { accountId } : {}),
      ...(threadId ? { threadId } : {}),
    };
  } catch {
    return null;
  }
}

async function sendAnnounceMessage(params: {
  runtime: PluginRuntime;
  target: AnnounceTarget;
  message: string;
  config: A2ABrokerAdapterPluginRuntimeConfig;
}): Promise<void> {
  const outbound = await params.runtime.channel.outbound.loadAdapter(params.target.channel as never);
  if (!outbound?.sendText) {
    return;
  }
  await outbound.sendText({
    cfg: params.config as never,
    to: params.target.to,
    text: params.message,
    ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
    ...(params.target.threadId ? { threadId: params.target.threadId } : {}),
  });
}

async function runAnnounceFlow(params: {
  runtime: PluginRuntime;
  config: A2ABrokerAdapterPluginRuntimeConfig;
  task: AnnounceFlowTask;
  randomId: () => string;
}): Promise<AnnounceFlowResult> {
  const primaryReply =
    normalizeOptionalString(params.task.event.task?.runtime?.roundOneReply) ??
    extractReplyFromBrokerTask(params.task.finalTask);
  if (!primaryReply) {
    return { status: "skipped", reason: "missing broker result reply" };
  }

  let latestReply = primaryReply;
  const requesterSessionKey = normalizeOptionalString(params.task.event.task?.requester?.sessionKey);
  const requesterChannel = normalizeOptionalString(params.task.event.task?.requester?.channel);
  const targetSessionKey =
    normalizeOptionalString(params.task.event.target?.sessionKey) ?? params.task.event.sessionKey;
  const targetChannel = (await resolveAnnounceTarget(params.runtime, targetSessionKey))?.channel;

  if (
    params.task.maxPingPongTurns > 0 &&
    requesterSessionKey &&
    requesterSessionKey !== targetSessionKey
  ) {
    let currentSessionKey = requesterSessionKey;
    let nextSessionKey = targetSessionKey;
    let incomingMessage = latestReply;
    for (let turn = 1; turn <= params.task.maxPingPongTurns; turn += 1) {
      const currentRole = currentSessionKey === requesterSessionKey ? "requester" : "target";
      const replyText = await runSubagentStep({
        runtime: params.runtime,
        sessionKey: currentSessionKey,
        message: incomingMessage,
        extraSystemPrompt: buildReplyContext({
          requesterSessionKey,
          requesterChannel,
          targetSessionKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.task.maxPingPongTurns,
        }),
        timeoutMs: params.task.announceTimeoutMs,
        randomId: params.randomId,
      });
      if (!replyText || replyText.trim() === REPLY_SKIP_TOKEN) {
        break;
      }
      latestReply = replyText;
      incomingMessage = replyText;
      const swap = currentSessionKey;
      currentSessionKey = nextSessionKey;
      nextSessionKey = swap;
    }
  }

  const announceReply = await runSubagentStep({
    runtime: params.runtime,
    sessionKey: targetSessionKey,
    message: "Agent-to-agent announce step.",
    extraSystemPrompt: buildAnnounceContext({
      requesterSessionKey,
      requesterChannel,
      targetSessionKey,
      targetChannel,
      originalMessage:
        normalizeOptionalString(params.task.event.task?.instructions) ??
        normalizeOptionalString(params.task.event.message) ??
        "",
      roundOneReply: primaryReply,
      latestReply,
    }),
    timeoutMs: params.task.announceTimeoutMs,
    randomId: params.randomId,
  });
  if (!announceReply || announceReply.trim() === ANNOUNCE_SKIP_TOKEN) {
    return { status: "skipped", reason: "announce reply skipped" };
  }

  const announceTarget = await resolveAnnounceTarget(params.runtime, targetSessionKey);
  if (!announceTarget) {
    return { status: "skipped", reason: "missing announce target" };
  }
  await sendAnnounceMessage({
    runtime: params.runtime,
    target: announceTarget,
    message: announceReply.trim(),
    config: params.config,
  });
  return { status: "sent" };
}

/**
 * Structurally extract the canonical `runtime.agent.waitRuns` seam from any
 * runtime-shaped object. Returns undefined when the seam is not present so the
 * caller can fall back to delegated dispatch on older host runtimes.
 */
export function readWaitRunsRuntime(
  runtime: PluginRuntime | undefined,
): AgentWaitRunRuntime | undefined {
  if (!runtime || typeof runtime !== "object") {
    return undefined;
  }
  const agent = (runtime as { agent?: unknown }).agent;
  if (!agent || typeof agent !== "object") {
    return undefined;
  }
  const waitRuns = (agent as { waitRuns?: unknown }).waitRuns;
  if (!waitRuns || typeof waitRuns !== "object") {
    return undefined;
  }
  const candidate = waitRuns as Record<string, unknown>;
  if (
    typeof candidate.create !== "function" ||
    typeof candidate.wait !== "function" ||
    typeof candidate.resolve !== "function" ||
    typeof candidate.fail !== "function" ||
    typeof candidate.cancel !== "function"
  ) {
    return undefined;
  }
  return waitRuns as AgentWaitRunRuntime;
}

/**
 * Returns true when the runtime exposes the seams required to run the
 * extracted delegated task lifecycle in-process: the canonical wait-run
 * registry plus the subagent/session/channel surfaces used by the announce
 * flow.
 */
export function supportsCanonicalDelegatedRuntime(
  runtime: PluginRuntime | undefined,
): runtime is PluginRuntime {
  if (!readWaitRunsRuntime(runtime)) {
    return false;
  }
  if (!runtime || typeof runtime !== "object") {
    return false;
  }
  const candidate = runtime as {
    subagent?: {
      run?: unknown;
      waitForRun?: unknown;
      getSessionMessages?: unknown;
    };
    agent?: {
      session?: {
        resolveStorePath?: unknown;
        loadSessionStore?: unknown;
      };
    };
    channel?: {
      outbound?: {
        loadAdapter?: unknown;
      };
    };
  };
  return Boolean(
    typeof candidate.subagent?.run === "function" &&
      typeof candidate.subagent?.waitForRun === "function" &&
      typeof candidate.subagent?.getSessionMessages === "function" &&
      typeof candidate.agent?.session?.resolveStorePath === "function" &&
      typeof candidate.agent?.session?.loadSessionStore === "function" &&
      typeof candidate.channel?.outbound?.loadAdapter === "function",
  );
}

export function createDelegatedTaskRuntime(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  runtime: PluginRuntime,
  deps: RuntimeDeps = {},
) {
  const waitRuns = readWaitRunsRuntime(runtime);
  if (!waitRuns) {
    throw new Error(
      "createDelegatedTaskRuntime requires runtime.agent.waitRuns canonical seam",
    );
  }

  const waitRunsRuntime = waitRuns;
  const activeTasks = new Map<string, ActiveDelegatedTask>();
  const createBrokerClient = deps.createBrokerClient ?? createConfiguredA2ABrokerClient;
  const registerCancelHandler: RegisterDelegatedSessionRunCancelHandler =
    deps.registerCancelHandler ?? (() => () => {});
  const randomId = deps.randomId ?? randomUUID;
  const backgroundTasks = new Set<Promise<unknown>>();
  const recentWakeKeys = new Set<string>();
  const MAX_RECENT_WAKE_KEYS = 256;

  function recordRecentWakeKey(wakeKey: string): void {
    recentWakeKeys.add(wakeKey);
    while (recentWakeKeys.size > MAX_RECENT_WAKE_KEYS) {
      const oldest = recentWakeKeys.values().next().value;
      if (oldest === undefined) break;
      recentWakeKeys.delete(oldest);
    }
  }

  const blockedAnnounceDeliveries = new Map<string, BlockedAnnounceDeliveryRecord>();
  const blockedAnnounceDeliveryByTaskId = new Map<string, string>();

  function trackBackground<T>(promise: Promise<T>): Promise<T> {
    backgroundTasks.add(promise);
    promise.finally(() => {
      backgroundTasks.delete(promise);
    });
    return promise;
  }

  function cleanup(task: ActiveDelegatedTask): void {
    task.monitorAbort.abort();
    task.disposeCancelHandler?.();
    activeTasks.delete(task.taskId);
  }

  function appendBlockedDeliveryAudit(
    record: BlockedAnnounceDeliveryRecord,
    event: Omit<BlockedAnnounceDeliveryAuditEvent, "eventId" | "deliveryId" | "taskId">,
  ): void {
    record.audit.push({
      eventId: `blocked-announce:${record.deliveryId}:${event.type}:${randomId()}`,
      deliveryId: record.deliveryId,
      taskId: record.taskId,
      ...event,
    });
  }

  function rememberBlockedAnnounceDelivery(
    task: ActiveDelegatedTask,
    policyContext: NonNullable<A2ABrokerTaskRecord["policyContext"]>,
  ): BlockedAnnounceDeliverySnapshot {
    const brokerTask = task.finalTask ?? task.acceptedTask;
    const deliveryId = deriveBlockedAnnounceDeliveryId(task.taskId, task.waitRunId);
    const now = new Date().toISOString();
    const existing = blockedAnnounceDeliveries.get(deliveryId);
    if (existing) {
      existing.updatedAt = now;
      existing.policyContext = policyContext;
      existing.announceTask = {
        acceptedTask: task.acceptedTask,
        event: task.event,
        announceTimeoutMs: task.announceTimeoutMs,
        maxPingPongTurns: task.maxPingPongTurns,
        ...(task.finalTask ? { finalTask: task.finalTask } : {}),
      };
      return cloneBlockedSnapshot(existing);
    }

    const targetSessionKey =
      normalizeOptionalString(task.event.target?.sessionKey) ?? task.event.sessionKey;
    const targetDisplayKey = normalizeOptionalString(task.event.target?.displayKey);
    const record: BlockedAnnounceDeliveryRecord = {
      deliveryId,
      taskId: task.taskId,
      waitRunId: task.waitRunId,
      mode: "human_approval_required",
      status: "blocked",
      reason: "live-impact task requires explicit human approval before external announce",
      targetSessionKey,
      ...(targetDisplayKey ? { targetDisplayKey } : {}),
      ...(normalizeOptionalString(task.event.task?.requester?.sessionKey)
        ? { requesterSessionKey: normalizeOptionalString(task.event.task?.requester?.sessionKey) }
        : {}),
      ...(normalizeOptionalString(task.event.task?.requester?.channel)
        ? { requesterChannel: normalizeOptionalString(task.event.task?.requester?.channel) }
        : {}),
      ...(normalizeOptionalString(task.event.task?.correlationId)
        ? { correlationId: normalizeOptionalString(task.event.task?.correlationId) }
        : {}),
      policyContext,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      audit: [],
      announceTask: {
        acceptedTask: task.acceptedTask,
        event: task.event,
        announceTimeoutMs: task.announceTimeoutMs,
        maxPingPongTurns: task.maxPingPongTurns,
        ...(task.finalTask ? { finalTask: task.finalTask } : {}),
      },
    };
    appendBlockedDeliveryAudit(record, {
      type: "blocked",
      timestamp: now,
      summary: `external announce blocked pending approval for task ${brokerTask.id}`,
    });
    blockedAnnounceDeliveries.set(deliveryId, record);
    blockedAnnounceDeliveryByTaskId.set(task.taskId, deliveryId);
    return cloneBlockedSnapshot(record);
  }

  function findBlockedAnnounceDelivery(
    signal: Pick<BlockedAnnounceDeliveryResumeSignal, "deliveryId" | "taskId">,
  ): BlockedAnnounceDeliveryRecord | undefined {
    const deliveryId = normalizeOptionalString(signal.deliveryId);
    if (deliveryId) {
      return blockedAnnounceDeliveries.get(deliveryId);
    }
    const taskId = normalizeOptionalString(signal.taskId);
    if (!taskId) {
      return undefined;
    }
    const mappedDeliveryId = blockedAnnounceDeliveryByTaskId.get(taskId);
    return mappedDeliveryId ? blockedAnnounceDeliveries.get(mappedDeliveryId) : undefined;
  }

  function settleBlockedDeliveryTerminal(
    signal: BlockedAnnounceDeliveryTerminalSignal,
  ): BlockedAnnounceDeliverySnapshot | undefined {
    const record = findBlockedAnnounceDelivery(signal);
    if (!record) {
      return undefined;
    }
    if (["delivering", "delivered", "rejected", "skipped"].includes(record.status)) {
      return cloneBlockedSnapshot(record);
    }
    const decidedAt = normalizeOptionalString(signal.decidedAt) ?? new Date().toISOString();
    const decidedBy = normalizeOptionalString(signal.decidedBy);
    const reason = signal.reason ?? `broker approval ${signal.outcome}`;
    record.status = "rejected";
    record.updatedAt = decidedAt;
    record.rejectedAt = decidedAt;
    record.rejectionReason = reason;
    const approvalId = normalizeOptionalString(signal.approvalId);
    if (approvalId) {
      record.approvalId = approvalId;
    }
    if (decidedBy) {
      record.approvedBy = decidedBy;
    }
    appendBlockedDeliveryAudit(record, {
      type: "approval_rejected",
      timestamp: decidedAt,
      ...(approvalId ? { approvalId } : {}),
      ...(decidedBy ? { approvedBy: decidedBy } : {}),
      summary: reason,
    });
    return cloneBlockedSnapshot(record);
  }

  async function resumeBlockedDelivery(
    signal: BlockedAnnounceDeliveryResumeSignal,
  ): Promise<BlockedAnnounceDeliveryResumeResult> {
    const approvalId = normalizeOptionalString(signal.approvalId);
    if (signal.approved !== true || !approvalId) {
      return {
        status: "rejected",
        reason: "blocked announce resume requires approved=true and a stable approvalId",
      };
    }
    const record = findBlockedAnnounceDelivery(signal);
    if (!record) {
      return { status: "not_found", reason: "blocked announce delivery not found" };
    }
    if (record.status === "delivering") {
      appendBlockedDeliveryAudit(record, {
        type: "duplicate_approval",
        timestamp: new Date().toISOString(),
        approvalId,
        ...(normalizeOptionalString(signal.approvedBy)
          ? { approvedBy: normalizeOptionalString(signal.approvedBy) }
          : {}),
        summary: "duplicate approval ignored while delivery is already resuming",
      });
      return {
        status: "duplicate",
        delivery: cloneBlockedSnapshot(record),
        reason: "delivery is already resuming",
      };
    }
    if (record.status === "delivered" || record.status === "rejected" || record.status === "skipped") {
      appendBlockedDeliveryAudit(record, {
        type: "duplicate_approval",
        timestamp: new Date().toISOString(),
        approvalId,
        ...(normalizeOptionalString(signal.approvedBy)
          ? { approvedBy: normalizeOptionalString(signal.approvedBy) }
          : {}),
        summary: "duplicate approval ignored after terminal delivery state",
      });
      return {
        status: "duplicate",
        delivery: cloneBlockedSnapshot(record),
        reason: "delivery already reached a terminal state",
      };
    }
    if (record.status !== "blocked" && record.status !== "failed") {
      return {
        status: "duplicate",
        delivery: cloneBlockedSnapshot(record),
        reason: `delivery is not resumable from status ${record.status}`,
      };
    }

    const approvedAt = normalizeOptionalString(signal.approvedAt) ?? new Date().toISOString();
    const approvedBy = normalizeOptionalString(signal.approvedBy);
    record.status = "delivering";
    record.updatedAt = approvedAt;
    record.approvedAt = approvedAt;
    record.approvalId = approvalId;
    if (approvedBy) {
      record.approvedBy = approvedBy;
    }
    record.attempts += 1;
    appendBlockedDeliveryAudit(record, {
      type: "approved",
      timestamp: approvedAt,
      approvalId,
      ...(approvedBy ? { approvedBy } : {}),
      summary: signal.reason ?? "operator approved blocked external announce delivery",
    });

    try {
      const result = await runAnnounceFlow({
        runtime,
        config,
        task: record.announceTask,
        randomId,
      });
      const finishedAt = new Date().toISOString();
      record.updatedAt = finishedAt;
      if (result.status === "sent") {
        record.status = "delivered";
        record.deliveredAt = finishedAt;
        appendBlockedDeliveryAudit(record, {
          type: "delivered",
          timestamp: finishedAt,
          approvalId,
          ...(approvedBy ? { approvedBy } : {}),
          summary: "approved external announce delivered exactly once",
        });
        return { status: "delivered", delivery: cloneBlockedSnapshot(record) };
      }
      record.status = "skipped";
      appendBlockedDeliveryAudit(record, {
        type: "skipped",
        timestamp: finishedAt,
        approvalId,
        ...(approvedBy ? { approvedBy } : {}),
        summary: result.reason,
      });
      return { status: "skipped", delivery: cloneBlockedSnapshot(record), reason: result.reason };
    } catch (error) {
      const failedAt = new Date().toISOString();
      record.status = "failed";
      record.updatedAt = failedAt;
      const message = error instanceof Error ? error.message : String(error);
      appendBlockedDeliveryAudit(record, {
        type: "failed",
        timestamp: failedAt,
        approvalId,
        ...(approvedBy ? { approvedBy } : {}),
        summary: message,
      });
      return { status: "rejected", reason: message };
    }
  }

  function isPending(waitRunId: string): boolean {
    const record = waitRunsRuntime.get(waitRunId);
    return !record || record.status === "pending";
  }

  function buildWakeOptions(): A2AWakeAfterAcceptanceOptions {
    const activeSessionKeys = new Set(
      [...activeTasks.values()]
        .map((task) => normalizeOptionalString(task.event.target?.sessionKey) ?? task.event.sessionKey)
        .filter((value): value is string => Boolean(value)),
    );
    const baseState = deps.wake?.state ?? {};
    const state: A2AWakeGuardState = {
      ...baseState,
      recentWakeKeys: baseState.recentWakeKeys ?? recentWakeKeys,
      activeSessionKeys,
    };
    return {
      ...deps.wake,
      runtime: deps.wake?.runtime ?? deps.wakeRuntime,
      config: deps.wake?.config ?? { enabled: shouldEnableWakeOnTask(config) },
      state,
      onResult: async (params) => {
        if (params.result.plan.status === "scheduled") {
          recordRecentWakeKey(params.result.plan.wakeKey);
        }
        await deps.wake?.onResult?.(params);
      },
    };
  }

  async function finalizeFromBrokerTask(
    task: ActiveDelegatedTask,
    brokerTask: A2ABrokerTaskRecord,
  ): Promise<void> {
    task.finalTask = brokerTask;
    if (!isPending(task.waitRunId)) {
      return;
    }
    const reply = extractReplyFromBrokerTask(brokerTask);
    if (brokerTask.status === "succeeded") {
      waitRunsRuntime.resolve({
        runId: task.waitRunId,
        ...(reply ? { replyText: reply } : {}),
      });
      return;
    }
    if (brokerTask.status === "canceled") {
      task.cancelReason = task.cancelReason ?? extractErrorMessage(brokerTask);
      waitRunsRuntime.cancel({ runId: task.waitRunId, error: task.cancelReason });
      return;
    }
    waitRunsRuntime.fail({
      runId: task.waitRunId,
      status: "error",
      error: extractErrorMessage(brokerTask),
      ...(reply ? { replyText: reply } : {}),
    });
  }

  async function monitorTask(task: ActiveDelegatedTask): Promise<void> {
    try {
      const initial = await task.broker.getTask(task.taskId);
      if (
        initial.status === "succeeded" ||
        initial.status === "failed" ||
        initial.status === "canceled"
      ) {
        await finalizeFromBrokerTask(task, initial);
        return;
      }
      for await (const event of task.broker.streamTaskEvents(task.taskId, {
        signal: task.monitorAbort.signal,
      })) {
        if (!event.data.final) {
          continue;
        }
        const brokerTask = buildTerminalBrokerTaskFromEvent(task, event)
          ?? await task.broker.getTask(task.taskId);
        await finalizeFromBrokerTask(task, brokerTask);
        return;
      }
      if (task.monitorAbort.signal.aborted) {
        return;
      }
      const brokerTask = await task.broker.getTask(task.taskId);
      await finalizeFromBrokerTask(task, brokerTask);
    } catch (error) {
      if (task.monitorAbort.signal.aborted) {
        return;
      }
      if (!isPending(task.waitRunId)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      waitRunsRuntime.fail({ runId: task.waitRunId, status: "error", error: message });
    }
  }

  async function run(event: SessionsSendHookEvent): Promise<SessionsSendHookResult> {
    if (!shouldUseStandaloneBrokerSessionsSendAdapter(config)) {
      return { handled: false, reason: "a2a broker adapter inactive" };
    }
    if (!event.task?.intent) {
      return { handled: false, reason: "no delegated task intent" };
    }

    const targetSessionKey =
      normalizeOptionalString(event.target?.sessionKey) ??
      normalizeOptionalString(event.sessionKey);
    const targetDisplayKey =
      normalizeOptionalString(event.target?.displayKey) ?? targetSessionKey ?? event.sessionKey;
    if (!targetSessionKey || !targetDisplayKey) {
      return { handled: false, reason: "missing target session" };
    }

    const announceTimeoutMs =
      normalizeFiniteNonNegativeNumber(event.task.runtime?.announceTimeoutMs) ?? 30_000;
    const maxPingPongTurns =
      normalizeFiniteNonNegativeNumber(event.task.runtime?.maxPingPongTurns) ??
      normalizeFiniteNonNegativeNumber(event.task.constraints?.maxPingPongTurns) ??
      0;
    const timeoutSeconds =
      normalizeFinitePositiveNumber(event.task.constraints?.timeoutSeconds) ??
      normalizeFinitePositiveNumber(
        (event.rawParams as Record<string, unknown> | undefined)?.timeoutSeconds,
      ) ??
      30;
    const waitTimeoutMs = Math.max(announceTimeoutMs, timeoutSeconds * 1000);
    const cancelTarget = normalizeSessionRunCancelTarget(event.task.runtime?.cancelTarget);
    const broker = createBrokerClient(config);
    const requestedWaitRunId = normalizeOptionalString(event.task.runtime?.waitRunId);

    const brokerTask = await broker.createTask(
      buildBrokerCreateTaskRequestFromOpenClaw({
        taskId: readRawTaskId(event.rawParams),
        waitRunId: requestedWaitRunId,
        correlationId: normalizeOptionalString(event.task.correlationId),
        parentRunId: normalizeOptionalString(event.task.parentRunId),
        requesterSessionKey: normalizeOptionalString(event.task.requester?.sessionKey),
        requesterChannel: normalizeOptionalString(event.task.requester?.channel),
        targetNodeId: normalizeOptionalString(event.target?.displayKey),
        targetSessionKey,
        targetDisplayKey,
        originalMessage:
          normalizeOptionalString(event.task.instructions) ??
          normalizeOptionalString(event.message) ??
          "",
        roundOneReply: normalizeOptionalString(event.task.runtime?.roundOneReply),
        announceTimeoutMs,
        maxPingPongTurns,
        cancelTarget,
      }),
    );

    await runA2AWakeAfterTaskAcceptance({
      task: brokerTask,
      fallback: {
        waitRunId: requestedWaitRunId,
        correlationId: normalizeOptionalString(event.task.correlationId),
        parentRunId: normalizeOptionalString(event.task.parentRunId),
        requesterSessionKey: normalizeOptionalString(event.task.requester?.sessionKey),
        requesterChannel: normalizeOptionalString(event.task.requester?.channel),
        targetSessionKey,
        targetDisplayKey,
      },
      wake: buildWakeOptions(),
    });

    const waitRunId =
      requestedWaitRunId ??
      normalizeOptionalString(
        (brokerTask.payload as Record<string, unknown> | undefined)?.waitRunId,
      ) ??
      brokerTask.id;
    waitRunsRuntime.create({ runId: waitRunId });

    const task: ActiveDelegatedTask = {
      taskId: brokerTask.id,
      waitRunId,
      broker,
      acceptedTask: brokerTask,
      event,
      waitTimeoutMs,
      announceTimeoutMs,
      maxPingPongTurns,
      monitorAbort: new AbortController(),
      monitorPromise: Promise.resolve(),
    };

    if (cancelTarget) {
      task.disposeCancelHandler = registerCancelHandler(cancelTarget, async () => {
        task.cancelReason = task.cancelReason ?? "session run cancelled";
        try {
          await broker.cancelTask(brokerTask.id, {
            actor: { id: cancelTarget.sessionKey, kind: "session", role: "hub" },
            reason: task.cancelReason,
          });
        } catch {
          // best effort only
        }
        if (isPending(waitRunId)) {
          waitRunsRuntime.cancel({ runId: waitRunId, error: task.cancelReason });
        }
        task.monitorAbort.abort();
        return { status: "cancelled", reason: task.cancelReason };
      });
    }

    activeTasks.set(task.taskId, task);
    const initialPolicyContext = getHumanGatePolicyContext(brokerTask);
    if (initialPolicyContext) {
      rememberBlockedAnnounceDelivery(task, initialPolicyContext);
    }
    task.monitorPromise = trackBackground(
      monitorTask(task).finally(async () => {
        const current = waitRunsRuntime.get(waitRunId);
        const deliveryTask = task.finalTask ?? task.acceptedTask;
        const policyContext = getHumanGatePolicyContext(deliveryTask);
        if (policyContext) {
          const delivery = rememberBlockedAnnounceDelivery(task, policyContext);
          const terminalSignal = buildBrokerApprovalTerminalSignal(deliveryTask);
          if (terminalSignal) {
            settleBlockedDeliveryTerminal({
              ...terminalSignal,
              deliveryId: delivery.deliveryId,
              taskId: delivery.taskId,
            });
          } else if (
            current?.status === "ok" &&
            !task.timeoutMessage &&
            !task.cancelReason &&
            task.finalTask?.status === "succeeded"
          ) {
            const approvalSignal = buildBrokerApprovalResumeSignal(deliveryTask);
            if (approvalSignal) {
              await resumeBlockedDelivery({
                ...approvalSignal,
                deliveryId: delivery.deliveryId,
                taskId: delivery.taskId,
              });
            }
          }
        } else if (
          current?.status === "ok" &&
          !task.timeoutMessage &&
          !task.cancelReason &&
          task.finalTask?.status === "succeeded"
        ) {
          void trackBackground(
            runAnnounceFlow({ runtime, config, task, randomId }).catch(() => ({
              status: "skipped" as const,
              reason: "announce flow failed",
            })),
          );
        }
        cleanup(task);
      }),
    );

    // Same precedence as the wait-timeout computation above: an explicit
    // constraints.timeoutSeconds wins over rawParams. Previously this was an
    // OR, so rawParams.timeoutSeconds=0 short-circuited to fire-and-forget
    // even when constraints asked for a synchronous wait.
    const effectiveTimeoutSeconds =
      normalizeFiniteNonNegativeNumber(event.task.constraints?.timeoutSeconds) ??
      normalizeFiniteNonNegativeNumber(
        (event.rawParams as Record<string, unknown> | undefined)?.timeoutSeconds,
      );
    const fireAndForget = effectiveTimeoutSeconds === 0;
    if (fireAndForget) {
      return {
        handled: true,
        mode: "direct",
        result: {
          runId: waitRunId,
          status: "accepted",
          sessionKey: targetDisplayKey,
          delivery: buildAnnounceDelivery(brokerTask, waitRunId),
        },
      };
    }

    const terminal = await waitRunsRuntime.wait({ runId: waitRunId, timeoutMs: waitTimeoutMs });

    if (terminal?.status === "timeout") {
      task.timeoutMessage = `delegated task timed out after ${waitTimeoutMs}ms`;
      try {
        await broker.cancelTask(brokerTask.id, {
          actor: {
            id: normalizeOptionalString(event.task?.requester?.sessionKey) ?? "openclaw",
            kind: "session",
            role: "hub",
          },
          reason: task.timeoutMessage,
        });
      } catch {
        // best effort only
      }
      if (isPending(waitRunId)) {
        waitRunsRuntime.fail({
          runId: waitRunId,
          status: "timeout",
          error: task.timeoutMessage,
        });
      }
      task.monitorAbort.abort();
      return {
        handled: true,
        mode: "direct",
        result: {
          runId: waitRunId,
          status: "timeout",
          error: task.timeoutMessage,
          sessionKey: targetDisplayKey,
        },
      };
    }

    const reply = extractReplyFromBrokerTask(task.finalTask);
    if (isTimeoutTask(task.finalTask)) {
      return {
        handled: true,
        mode: "direct",
        result: {
          runId: waitRunId,
          status: "timeout",
          error: extractErrorMessage(task.finalTask),
          sessionKey: targetDisplayKey,
        },
      };
    }
    if (task.cancelReason) {
      return {
        handled: true,
        mode: "direct",
        result: {
          runId: waitRunId,
          status: "cancelled",
          error: task.cancelReason,
          sessionKey: targetDisplayKey,
        },
      };
    }
    if (terminal?.status === "ok") {
      const deliveryTask = task.finalTask ?? task.acceptedTask;
      const policyContext = getHumanGatePolicyContext(deliveryTask);
      if (task.finalTask?.status === "succeeded" && policyContext) {
        rememberBlockedAnnounceDelivery(task, policyContext);
      }
      return {
        handled: true,
        mode: "direct",
        result: {
          runId: waitRunId,
          status: "ok",
          ...(reply ? { reply } : {}),
          sessionKey: targetDisplayKey,
          delivery: buildAnnounceDelivery(deliveryTask, waitRunId),
        },
      };
    }
    return {
      handled: true,
      mode: "direct",
      result: {
        runId: waitRunId,
        status: "error",
        error: terminal?.error ?? extractErrorMessage(task.finalTask),
        sessionKey: targetDisplayKey,
      },
    };
  }

  async function waitForIdle(): Promise<void> {
    while (backgroundTasks.size > 0) {
      await Promise.allSettled([...backgroundTasks]);
    }
  }

  function shutdown(): void {
    for (const task of [...activeTasks.values()]) {
      cleanup(task);
      waitRunsRuntime.clear(task.waitRunId);
    }
  }

  function getBlockedAnnounceDeliveries(): BlockedAnnounceDeliverySnapshot[] {
    return [...blockedAnnounceDeliveries.values()].map((record) => cloneBlockedSnapshot(record));
  }

  function getBlockedAnnounceDelivery(
    deliveryIdOrTaskId: string,
  ): BlockedAnnounceDeliverySnapshot | null {
    const normalized = normalizeOptionalString(deliveryIdOrTaskId);
    if (!normalized) {
      return null;
    }
    const record =
      blockedAnnounceDeliveries.get(normalized) ??
      (blockedAnnounceDeliveryByTaskId.get(normalized)
        ? blockedAnnounceDeliveries.get(blockedAnnounceDeliveryByTaskId.get(normalized)!)
        : undefined);
    return record ? cloneBlockedSnapshot(record) : null;
  }

  return {
    run,
    shutdown,
    waitForIdle,
    resumeBlockedDelivery,
    getBlockedAnnounceDeliveries,
    getBlockedAnnounceDelivery,
  };
}

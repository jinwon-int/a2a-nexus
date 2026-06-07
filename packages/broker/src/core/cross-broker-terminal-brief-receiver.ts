import type { CrossBrokerTerminalBriefProjectionRequest } from "./cross-broker-terminal-brief.js";
import type { TerminalTaskOutboxEvent, TerminalTaskEventPayload } from "./terminal-event-outbox.js";
import type { TaskStatus } from "./types.js";

const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled", "blocked"]);

export interface CrossBrokerTerminalBriefReceiverConfig {
  sourceBrokerId: string;
  sourceBaseUrl: string;
  destinationBrokerId: string;
  destinationBaseUrl: string;
  cursor?: string | null;
  limit?: number;
  reconcileUnacked?: boolean;
  requesterId?: string;
  requesterRole?: "hub" | "operator";
  sourceEdgeSecret?: string;
  destinationEdgeSecret?: string;
  edgeSecret?: string;
}

export interface CrossBrokerTerminalBriefReceiverFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type CrossBrokerTerminalBriefReceiverFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<CrossBrokerTerminalBriefReceiverFetchResponse>;

export interface CrossBrokerTerminalBriefReceiverPollResult {
  ok: boolean;
  sourceCursor: string | null;
  cursorToPersist: string | null;
  fetched: number;
  ignored: number;
  posted: number;
  accepted: number;
  replayed: number;
  blocked: Array<{
    eventId: string;
    code: string;
    reason: string;
  }>;
}

export function buildCrossBrokerTerminalBriefProjectionFromEvent(
  event: TerminalTaskOutboxEvent,
  config: Pick<CrossBrokerTerminalBriefReceiverConfig, "sourceBrokerId" | "destinationBrokerId">,
): CrossBrokerTerminalBriefProjectionRequest | null {
  const payload = event.payload;
  if (!isParentOwnedCrossBrokerTerminalPayload(payload, config)) return null;

  const parentRoundOrder = positiveInt(payload.parentRoundOrder ?? payload.parentRoundProgress);
  const parentRoundTotal = positiveInt(payload.parentRoundTotal);
  if (!payload.parentRoundId || !parentRoundTotal || !parentRoundOrder) return null;

  const completedAt = normalizeIso(payload.completedAt ?? payload.updatedAt ?? event.createdAt);
  if (!completedAt) return null;

  const handoffBrokerId = token(payload.crossBrokerHandoff?.handoffBrokerId) ?? config.sourceBrokerId;
  return {
    parentRoundId: payload.parentRoundId,
    originBrokerId: handoffBrokerId,
    brokerOfRecordId: payload.brokerOfRecordId ?? payload.notificationOwnership?.ownerBrokerId ?? config.destinationBrokerId,
    childTaskId: payload.taskId,
    childRunId: payload.run,
    childWorkerId: payload.crossBrokerHandoff?.childWorkerId ?? payload.worker,
    status: payload.status,
    summary: payload.testSummary ?? payload.taskDescription,
    taskBrief: payload.taskBrief,
    terminalBriefTitle: payload.terminalBriefTitle ?? payload.title,
    evidenceUrl: firstDefined(payload.doneUrl, payload.prUrl, payload.blockUrl),
    completedAt,
    emittedAt: normalizeIso(event.createdAt) ?? completedAt,
    parentRoundTotal,
    parentRoundOrder,
    terminalAck: false,
  };
}

export function isParentOwnedCrossBrokerTerminalPayload(
  payload: TerminalTaskEventPayload,
  config: Pick<CrossBrokerTerminalBriefReceiverConfig, "sourceBrokerId" | "destinationBrokerId">,
): payload is TerminalTaskEventPayload & {
  parentRoundId: string;
  notificationOwnership: NonNullable<TerminalTaskEventPayload["notificationOwnership"]>;
  crossBrokerHandoff: NonNullable<TerminalTaskEventPayload["crossBrokerHandoff"]>;
} {
  if (!TERMINAL_STATUSES.has(payload.status)) return false;
  if (!payload.parentRoundId) return false;
  if (payload.notificationOwnership?.scope !== "parent-broker-only") return false;
  if (payload.notificationOwnership.ownerBrokerId !== config.destinationBrokerId) return false;
  if (payload.brokerOfRecordId && payload.brokerOfRecordId !== config.destinationBrokerId) return false;
  if (!payload.crossBrokerHandoff) return false;
  if (payload.crossBrokerHandoff.handoffBrokerId && payload.crossBrokerHandoff.handoffBrokerId !== config.sourceBrokerId) return false;
  return true;
}

export async function pollCrossBrokerTerminalBriefReceiver(
  config: CrossBrokerTerminalBriefReceiverConfig,
  fetchImpl: CrossBrokerTerminalBriefReceiverFetch,
): Promise<CrossBrokerTerminalBriefReceiverPollResult> {
  const sourceUrl = terminalOutboxUrl(config);
  const sourceResponse = await fetchImpl(sourceUrl, { headers: receiverHeaders(config, "source") });
  if (!sourceResponse.ok) {
    return {
      ok: false,
      sourceCursor: config.cursor ?? null,
      cursorToPersist: config.cursor ?? null,
      fetched: 0,
      ignored: 0,
      posted: 0,
      accepted: 0,
      replayed: 0,
      blocked: [{ eventId: "source", code: `source_http_${sourceResponse.status}`, reason: "source terminal-outbox poll failed" }],
    };
  }

  const sourceBody = await sourceResponse.json() as { events?: TerminalTaskOutboxEvent[]; cursor?: string | null };
  const events = Array.isArray(sourceBody.events) ? sourceBody.events : [];
  let ignored = 0;
  let posted = 0;
  let accepted = 0;
  let replayed = 0;
  const blocked: CrossBrokerTerminalBriefReceiverPollResult["blocked"] = [];

  for (const event of events) {
    const projection = buildCrossBrokerTerminalBriefProjectionFromEvent(event, config);
    if (!projection) {
      ignored += 1;
      continue;
    }

    posted += 1;
    const destinationResponse = await fetchImpl(crossBrokerProjectionUrl(config), {
      method: "POST",
      headers: receiverHeaders(config, "destination"),
      body: JSON.stringify(projection),
    });
    const destinationBody = await destinationResponse.json().catch(() => ({})) as {
      accepted?: boolean;
      replayed?: boolean;
      ack?: { code?: string; reason?: string };
    };

    if (destinationResponse.ok && destinationBody.accepted === true) {
      accepted += 1;
      if (destinationBody.replayed) replayed += 1;
      continue;
    }

    blocked.push({
      eventId: event.id,
      code: destinationBody.ack?.code ?? `destination_http_${destinationResponse.status}`,
      reason: destinationBody.ack?.reason ?? "destination projection ingest failed",
    });
  }

  const sourceCursor = sourceBody.cursor ?? events.at(-1)?.id ?? config.cursor ?? null;
  return {
    ok: blocked.length === 0,
    sourceCursor,
    cursorToPersist: blocked.length === 0 ? sourceCursor : config.cursor ?? null,
    fetched: events.length,
    ignored,
    posted,
    accepted,
    replayed,
    blocked,
  };
}

function terminalOutboxUrl(config: CrossBrokerTerminalBriefReceiverConfig): string {
  const url = new URL("/a2a/tasks/terminal-outbox", baseWithSlash(config.sourceBaseUrl));
  if (config.cursor) url.searchParams.set("after_id", config.cursor);
  if (config.limit) url.searchParams.set("limit", String(config.limit));
  if (config.reconcileUnacked) url.searchParams.set("reconcile_unacked", "true");
  return url.toString();
}

function crossBrokerProjectionUrl(config: CrossBrokerTerminalBriefReceiverConfig): string {
  return new URL("/a2a/cross-broker/terminal-briefs", baseWithSlash(config.destinationBaseUrl)).toString();
}

function receiverHeaders(config: CrossBrokerTerminalBriefReceiverConfig, target: "source" | "destination"): Record<string, string> {
  const edgeSecret = target === "source"
    ? config.sourceEdgeSecret ?? config.edgeSecret
    : config.destinationEdgeSecret ?? config.edgeSecret;
  return {
    "content-type": "application/json",
    "x-a2a-requester-id": config.requesterId ?? `${config.sourceBrokerId}-terminal-brief-receiver`,
    "x-a2a-requester-role": config.requesterRole ?? "hub",
    ...(edgeSecret ? { "x-a2a-edge-secret": edgeSecret } : {}),
  };
}

function baseWithSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

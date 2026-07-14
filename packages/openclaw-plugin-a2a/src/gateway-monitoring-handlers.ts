/**
 * A2A monitoring gateway method handlers.
 *
 * These handlers own the gateway RPC surface for a2a.alerts.list and a2a.monitor.status.
 * They delegate to the standalone a2a-broker HTTP endpoint's diagnostics and alerts APIs.
 */
import { readFileSync } from "node:fs";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createConfiguredA2ABrokerClient,
  resolveA2ABrokerAdapterPluginConfig,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../config.js";
import { A2ABrokerClientError, createA2ABrokerClient } from "../standalone-broker-client.js";
import {
  buildDisabledA2AOperatorEventBridgeState,
  buildUnavailableA2AOperatorEventBridgeState,
  createA2AOperatorEventBridge,
  type A2AOperatorEventBridge,
  type A2AOperatorEventBridgeBrokerClient,
  type A2AOperatorEventBridgeState,
} from "./operator-event-bridge.js";
import type { A2ACrossBrokerTerminalProjection } from "./cross-broker-terminal-relay.js";
import {
  createA2AOperatorNotificationAdapter,
  preflightA2AOperatorNotificationRuntime,
} from "./operator-notification-adapter.js";
import type {
  A2AMonitorStatusParams,
} from "./gateway-schema.js";
import {
  validateA2AAlertsListParams,
  validateA2AMonitorStatusParams,
  validateParams,
} from "./gateway-validators.js";
import { a2aError, A2AErrorCodes } from "./plugin-errors.js";

function readOperatorEventsConfig(config: A2ABrokerAdapterPluginRuntimeConfig): Record<string, unknown> | undefined {
  const entry = config.plugins?.entries?.["a2a-broker-adapter"];
  const value = entry?.config?.operatorEvents;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

interface CrossBrokerConfig {
  baseUrl: string;
  edgeSecret?: string;
  label?: string;
  requesterId?: string;
  terminalOutboxAllowedIds?: string[];
  terminalOutboxCursor?: string;
  terminalOutboxReconcileUnackedOnStart?: boolean;
  handoffBrokerId?: string;
  maxSummaryChars?: number;
}

interface CrossBrokerTerminalRelayConfig {
  enabled: boolean;
  baseUrl: string;
  edgeSecret?: string;
  label?: string;
  handoffBrokerId?: string;
  maxSummaryChars?: number;
}

type OperatorEventBridgeFactoryParams = {
  broker: A2AOperatorEventBridgeBrokerClient;
  readTerminalOutboxAllowedIds?: () => readonly string[];
  readTerminalOutboxCursor?: () => string | undefined;
  terminalOutboxCursor?: string;
  terminalOutboxReconcileUnackedOnStart?: boolean;
  handoffBrokerId?: string;
  terminalProjectionMaxSummaryChars?: number;
  notifyOperator?: boolean;
  relayTerminalProjection?: (
    projection: A2ACrossBrokerTerminalProjection,
  ) => void | { accepted?: boolean; reason?: string } | Promise<void | { accepted?: boolean; reason?: string }>;
};

function readSecretFile(value: unknown): string | undefined {
  const filePath = readString(value);
  if (!filePath || !filePath.startsWith("/")) return undefined;
  try {
    return readFileSync(filePath, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function readBrokerIdLikeLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(value) ? value : undefined;
}

function readCrossBrokerHandoffBrokerId(rec: Record<string, unknown>, ownerLocalBrokerId: string | undefined): string | undefined {
  const explicit =
    readString(rec.handoffBrokerId) ??
    readString(rec.remoteBrokerId) ??
    readString(rec.brokerId);
  if (explicit) return explicit;

  const localBrokerId = readString(rec.localBrokerId);
  if (localBrokerId && localBrokerId !== ownerLocalBrokerId) return localBrokerId;

  return readBrokerIdLikeLabel(readString(rec.label));
}

function readCrossBrokersConfig(raw: Record<string, unknown> | undefined, ownerLocalBrokerId?: string): CrossBrokerConfig[] {
  if (!raw) return [];
  const arr = raw.crossBrokers;
  if (!Array.isArray(arr)) return [];
  const results: CrossBrokerConfig[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const baseUrl = typeof rec.baseUrl === "string" && rec.baseUrl.trim() ? rec.baseUrl.trim() : undefined;
    if (!baseUrl) continue;
    const edgeSecret = readString(rec.edgeSecret) ?? readSecretFile(rec.edgeSecretFile);
    const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : undefined;
    const requesterId = typeof rec.requesterId === "string" && rec.requesterId.trim() ? rec.requesterId.trim() : undefined;
    const terminalOutboxAllowedIds = readStringArray(rec.terminalOutboxAllowedIds);
    const terminalOutboxCursor = readString(rec.terminalOutboxCursor);
    const terminalOutboxReconcileUnackedOnStart = readBoolean(rec.terminalOutboxReconcileUnackedOnStart);
    const handoffBrokerId = readCrossBrokerHandoffBrokerId(rec, ownerLocalBrokerId);
    const maxSummaryChars = typeof rec.maxSummaryChars === "number" && Number.isFinite(rec.maxSummaryChars)
      ? Math.max(80, Math.min(2_000, Math.trunc(rec.maxSummaryChars)))
      : undefined;
    results.push({
      baseUrl,
      ...(edgeSecret ? { edgeSecret } : {}),
      ...(label ? { label } : {}),
      ...(requesterId ? { requesterId } : {}),
      ...(terminalOutboxAllowedIds.length ? { terminalOutboxAllowedIds } : {}),
      ...(terminalOutboxCursor ? { terminalOutboxCursor } : {}),
      ...(terminalOutboxReconcileUnackedOnStart !== undefined ? { terminalOutboxReconcileUnackedOnStart } : {}),
      ...(handoffBrokerId ? { handoffBrokerId } : {}),
      ...(maxSummaryChars ? { maxSummaryChars } : {}),
    });
  }
  return results;
}

function readCrossBrokerTerminalRelayConfig(raw: Record<string, unknown> | undefined): CrossBrokerTerminalRelayConfig | undefined {
  if (!raw) return undefined;
  const rec = readRecord(raw.crossBrokerTerminalRelay) ?? readRecord(raw.terminalProjectionRelay);
  if (!rec || rec.enabled !== true) return undefined;
  const origin = readRecord(rec.originBroker) ?? rec;
  const baseUrl = readString(origin.baseUrl);
  if (!baseUrl) return undefined;
  const edgeSecret = readString(origin.edgeSecret) ?? readSecretFile(origin.edgeSecretFile);
  const label = readString(origin.label) ?? readString(rec.label);
  const handoffBrokerId = readString(rec.handoffBrokerId) ?? readString(rec.localBrokerId);
  const maxSummaryChars = typeof rec.maxSummaryChars === "number" && Number.isFinite(rec.maxSummaryChars)
    ? Math.max(80, Math.min(2_000, Math.trunc(rec.maxSummaryChars)))
    : undefined;
  return {
    enabled: true,
    baseUrl,
    ...(edgeSecret ? { edgeSecret } : {}),
    ...(label ? { label } : {}),
    ...(handoffBrokerId ? { handoffBrokerId } : {}),
    ...(maxSummaryChars ? { maxSummaryChars } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export type A2ABrokerAuditBottleneckWarning = {
  code: "broker_audit_bottleneck";
  severity: "warn";
  source: "broker.health";
  message: string;
  auditRows?: number;
  maxAuditEvents?: number;
  heartbeatRatio?: number;
  healthLatencyMs?: number;
  dominantEventType?: string;
};

export type A2ABrokerRuntimeOwnerMetadata = {
  manager?: string;
  service?: string;
  unit?: string;
  composeProject?: string;
  composeService?: string;
  containerName?: string;
};

export type A2ABrokerBuildInfoMetadata = {
  source: "broker.health";
  version: string;
  revision: string;
  image: string;
};

export type A2AOperatorReceiptProjectionState =
  | "accepted"
  | "sent"
  | "provider-delivered-if-known"
  | "operator-visible"
  | "timed_out"
  | "stale"
  | "failed"
  | "pending";

export type A2AOperatorVisibleTerminalReceiptState =
  | "pending_receipt"
  | "timed_out"
  | "stale"
  | "failed"
  | "duplicate_suppressed"
  | "receipt_confirmed";

export type A2ABrokerTerminalReceiptGapProjection = {
  taskId: string;
  status?: string;
  receiptState: A2AOperatorReceiptProjectionState;
  /** Provider/transport state only; never evidence of operator-visible receipt by itself. */
  providerDeliveryState?: Extract<A2AOperatorReceiptProjectionState, "accepted" | "sent" | "provider-delivered-if-known">;
  receiptStatus: "received" | "pending";
  receiptGapStatus: "confirmed" | "missing" | "timed_out" | "stale" | "failed" | "duplicate_suppressed";
  /** Operator-actionable receipt state, separate from provider send/delivery status. */
  operatorReceiptState: A2AOperatorVisibleTerminalReceiptState;
  operatorReceiptLabel: string;
  brokerReceiptClassification?: string;
  terminalAckEligible: boolean;
  reason: string;
};

export type A2ABrokerTerminalReceiptGapWarning = {
  code: "terminal_receipt_gap";
  severity: "warn";
  source: "broker.diagnostics";
  message: string;
  count: number;
  taskIds: string[];
};

export type A2ABrokerNoLiveRehearsalProjection = {
  mode: "release-dryrun/no-live";
  status: "ready" | "blocked";
  manifestId?: string;
  runId?: string;
  receiptStates: Array<{
    taskId?: string;
    state: A2AOperatorReceiptProjectionState;
    terminalAckEligible: boolean;
    reason: string;
  }>;
  gateFindings: Array<{
    code: string;
    status: "pass" | "blocked";
    message: string;
  }>;
  auditFindings: Array<{
    code: string;
    status: "pass" | "blocked";
    message: string;
  }>;
  missingUnsafeEvidenceFields: string[];
  safeOperations: {
    liveSend: false;
    terminalOutboxAck: false;
    gatewayRestart: false;
    productionDeploy: false;
    providerSend: false;
  };
};

export type A2ABrokerNoLiveRehearsalWarning = {
  code: "no_live_rehearsal_blocked";
  severity: "warn";
  source: "broker.rehearsalManifest";
  message: string;
  missingUnsafeEvidenceFields: string[];
};

export type A2ABrokerLiveReadinessProjection = {
  mode: "release-dryrun/no-live";
  status: "ready" | "blocked";
  runId?: string;
  canaryResults: Array<{
    code: string;
    status: "pass" | "blocked";
    message: string;
  }>;
  evidenceAcceptance: Array<{
    kind: "PR" | "Done" | "Block" | "missing_evidence";
    status: "accepted" | "missing" | "blocked";
    taskId?: string;
    issue?: string;
    url?: string;
    message: string;
  }>;
  queueSignals: {
    status: "ready" | "blocked";
    queued: number;
    claimed: number;
    running: number;
    stale: number;
    timedOut: number;
    messages: string[];
  };
  safeOperations: A2ABrokerNoLiveRehearsalProjection["safeOperations"];
};

export type A2ABrokerLiveReadinessWarning = {
  code: "live_readiness_blocked";
  severity: "warn";
  source: "broker.liveReadiness";
  message: string;
};

// ── Broker pressure projection ───────────────────────────────────────

/**
 * Synthesized broker pressure signal for operator gate decisions.
 * Provider send/message-id remains non-ACK evidence.
 */
export type A2ABrokerPressureProjection = {
  status: "elevated" | "normal" | "unknown";
  pressure: {
    /** Queue depth from operator-snapshot or live-summary. */
    queueDepth: number;
    /** Tasks queued vs total active: 0..1 pressure ratio. */
    queuePressureRatio: number;
    /** Audit table bottleneck ratio (rows/max), 0..1 when available. */
    auditPressureRatio?: number;
    /** Health check latency in ms. */
    healthLatencyMs?: number;
    /** Number of stale/unknown workers. */
    staleWorkerCount: number;
    /** Total tracked workers. */
    totalWorkerCount: number;
  };
  messages: string[];
};

// ── Queue hygiene projection ─────────────────────────────────────────

/**
 * Synthesized queue hygiene signal for operator gate decisions.
 * Provider send/message-id remains non-ACK evidence; terminal ACK
 * requires operator-visible/manual-receipt confirmation.
 */
export type A2AQueueHygieneProjection = {
  status: "clean" | "stale" | "timed_out" | "blocked" | "unknown";
  hygiene: {
    staleTaskCount: number;
    timedOutTaskCount: number;
    unacknowledgedOutboxCount: number;
    receiptGapCount: number;
    pendingLocalQueueCount: number;
    claimedRunningCount: number;
  };
  messages: string[];
};

// ── Combined operator status projection ──────────────────────────────

/**
 * Top-level operator-facing status projection that coalesces broker
 * pressure and queue hygiene signals for gate decisions.
 *
 * Provider send success remains non-ACK evidence; terminal ACK requires
 * operator-visible current-session or manual-receipt confirmation.
 */
export type A2AOperatorStatusProjection = {
  mode: "operator-status-dryrun/no-live";
  brokerPressure: A2ABrokerPressureProjection;
  queueHygiene: A2AQueueHygieneProjection;
  /** Provider send/message-id is explicitly non-ACK evidence. */
  providerSendNotAckEvidence: true;
  safeOperations: {
    liveSend: false;
    terminalOutboxAck: false;
    gatewayRestart: false;
    productionDeploy: false;
    providerSend: false;
  };
};

export function createA2AMonitoringHandlers(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: {
    createClient?: typeof createConfiguredA2ABrokerClient;
    createStandaloneBrokerClient?: typeof createA2ABrokerClient;
    createOperatorEventBridge?: (params: OperatorEventBridgeFactoryParams) => A2AOperatorEventBridge;
    runtime?: unknown;
    now?: () => number;
  } = {},
) {
  type RawBrokerClient = ReturnType<typeof createConfiguredA2ABrokerClient>;

  const resolvedConfig = resolveA2ABrokerAdapterPluginConfig(config);
  const createClient = deps.createClient ?? createConfiguredA2ABrokerClient;
  const createStandaloneBrokerClient = deps.createStandaloneBrokerClient ?? createA2ABrokerClient;
  const notificationAdapter = createA2AOperatorNotificationAdapter(config, deps.runtime, {
    ...(deps.now ? { now: deps.now } : {}),
  });
  const operatorEventsConfig = readOperatorEventsConfig(config);
  const terminalOutboxReconcileUnackedOnStart = readBoolean(operatorEventsConfig?.terminalOutboxReconcileUnackedOnStart);
  const localBrokerId =
    readString(operatorEventsConfig?.localBrokerId) ??
    readString(operatorEventsConfig?.brokerId) ??
    readString(operatorEventsConfig?.handoffBrokerId);
  const crossBrokerTerminalRelayConfig = readCrossBrokerTerminalRelayConfig(operatorEventsConfig);
  const readCurrentTerminalOutboxAllowedIds = () =>
    readStringArray(readOperatorEventsConfig(config)?.terminalOutboxAllowedIds);
  const readCurrentTerminalOutboxCursor = () =>
    readString(readOperatorEventsConfig(config)?.terminalOutboxCursor);
  const readCurrentOperatorEventCursor = () =>
    readString(readOperatorEventsConfig(config)?.cursor);
  type CrossBrokerTerminalRelayClient = ReturnType<typeof createA2ABrokerClient> & { relayTerminalProjection?: (projection: Record<string, unknown>) => Promise<unknown> };
  let crossBrokerTerminalRelayClient: CrossBrokerTerminalRelayClient | undefined;

  function getCrossBrokerTerminalRelayClient(): CrossBrokerTerminalRelayClient | undefined {
    if (!crossBrokerTerminalRelayConfig) return undefined;
    if (!crossBrokerTerminalRelayClient) {
      crossBrokerTerminalRelayClient = createStandaloneBrokerClient({
        baseUrl: crossBrokerTerminalRelayConfig.baseUrl,
        ...(crossBrokerTerminalRelayConfig.edgeSecret ? { edgeSecret: crossBrokerTerminalRelayConfig.edgeSecret } : {}),
        requester: { id: "plugin-a2a", kind: "service", role: "hub" },
      }) as unknown as CrossBrokerTerminalRelayClient;
    }
    return crossBrokerTerminalRelayClient;
  }

  // Cross-broker support: poll additional brokers' terminal outboxes
  const crossBrokerConfigs = readCrossBrokersConfig(operatorEventsConfig, localBrokerId);
  const crossBrokerClients = new Map<string, A2AOperatorEventBridgeBrokerClient>();
  const crossBridges = new Map<string, A2AOperatorEventBridge>();

  function initCrossBrokers(): void {
    for (const cfg of crossBrokerConfigs) {
      const key = cfg.label ?? new URL(cfg.baseUrl).hostname;
      if (crossBrokerClients.has(key)) continue;
      try {
        // Cross-broker client: no write/create methods needed, only terminal-outbox read/ack
        const client = createStandaloneBrokerClient({
          baseUrl: cfg.baseUrl,
          ...(cfg.edgeSecret ? { edgeSecret: cfg.edgeSecret } : {}),
          requester: { id: cfg.requesterId ?? cfg.label ?? "cross-broker-client", kind: "node", role: "hub" },
        }) as unknown as A2AOperatorEventBridgeBrokerClient;
        crossBrokerClients.set(key, client);
      } catch {
        // Cross broker unreachable at init time; skip, will retry on next start
      }
    }
  }

  function startCrossBridges(): void {
    for (const [key, client] of crossBrokerClients) {
      if (crossBridges.has(key)) continue;
      const cfg = crossBrokerConfigs.find((item) => (item.label ?? new URL(item.baseUrl).hostname) === key);
      try {
        const bridge = createOperatorEventBridgeFactory({
          broker: client,
          ...(cfg?.terminalOutboxAllowedIds ? { readTerminalOutboxAllowedIds: () => cfg.terminalOutboxAllowedIds ?? [] } : {}),
          ...(cfg?.terminalOutboxCursor ? {
            readTerminalOutboxCursor: () => cfg.terminalOutboxCursor,
            terminalOutboxCursor: cfg.terminalOutboxCursor,
          } : {}),
          ...(cfg?.terminalOutboxReconcileUnackedOnStart !== undefined
            ? { terminalOutboxReconcileUnackedOnStart: cfg.terminalOutboxReconcileUnackedOnStart }
            : {}),
          ...(cfg?.handoffBrokerId ? { handoffBrokerId: cfg.handoffBrokerId } : {}),
          ...(cfg?.maxSummaryChars ? { terminalProjectionMaxSummaryChars: cfg.maxSummaryChars } : {}),
          notifyOperator: false,
          relayTerminalProjection: async (projection) => {
            const originClient = getRawClient() as (RawBrokerClient & { relayTerminalProjection?: (projection: Record<string, unknown>) => Promise<unknown> }) | null;
            if (!originClient?.relayTerminalProjection) {
              throw new Error("local broker client does not expose relayTerminalProjection");
            }
            await originClient.relayTerminalProjection(projection as unknown as Record<string, unknown>);
            return {
              accepted: true,
              reason: `local broker accepted cross-broker Terminal Brief projection from ${cfg?.label ?? key}`,
            };
          },
        });
        bridge.getState(); // triggers ensureStarted() internally
        crossBridges.set(key, bridge);
      } catch {
        // Cross broker bridge start failed; skip, will retry on next start
      }
    }
  }

  function shutdownCrossBridges(): void {
    for (const [, bridge] of crossBridges) {
      try { bridge.shutdown(); } catch { /* best-effort */ }
    }
    crossBridges.clear();
    crossBrokerClients.clear();
  }

  const createOperatorEventBridgeFactory =
    deps.createOperatorEventBridge ??
    ((params: OperatorEventBridgeFactoryParams) => {
      const bridgeLocalBrokerId = params.handoffBrokerId ?? localBrokerId ?? crossBrokerTerminalRelayConfig?.handoffBrokerId;
      const operatorNotificationEnabled = params.notifyOperator !== false;
      return createA2AOperatorEventBridge({
        broker: params.broker,
        ...(operatorNotificationEnabled && notificationAdapter
          ? {
              notifyOperator: async (envelope) => {
                const receipt = await notificationAdapter.notify(envelope);
                return {
                  ackTerminalEvent: Boolean(receipt && !receipt.dryRun),
                  ...(receipt?.confirmationSource === "current_session_visible" || receipt?.confirmationSource === "manual_operator_receipt"
                    ? { confirmationSource: receipt.confirmationSource }
                    : {}),
                  reason: receipt
                    ? `operator notification receipt confirmed via ${receipt.confirmationSource}`
                    : "operator notification sent without current-session/manual receipt confirmation",
                };
              },
            }
          : {}),
        readTerminalOutboxAllowedIds: params.readTerminalOutboxAllowedIds ?? readCurrentTerminalOutboxAllowedIds,
        readTerminalOutboxCursor: params.readTerminalOutboxCursor ?? readCurrentTerminalOutboxCursor,
        readCursor: readCurrentOperatorEventCursor,
        ...((params.terminalOutboxCursor ?? readCurrentTerminalOutboxCursor())
          ? { terminalOutboxCursor: params.terminalOutboxCursor ?? readCurrentTerminalOutboxCursor() }
          : {}),
        ...((params.terminalOutboxReconcileUnackedOnStart ?? terminalOutboxReconcileUnackedOnStart) !== undefined
          ? { terminalOutboxReconcileUnackedOnStart: params.terminalOutboxReconcileUnackedOnStart ?? terminalOutboxReconcileUnackedOnStart }
          : {}),
        ...(bridgeLocalBrokerId ? { handoffBrokerId: bridgeLocalBrokerId } : {}),
        ...(params.relayTerminalProjection
          ? {
              relayTerminalProjection: params.relayTerminalProjection,
              ...(params.terminalProjectionMaxSummaryChars
                ? { terminalProjectionMaxSummaryChars: params.terminalProjectionMaxSummaryChars }
                : {}),
            }
          : {}),
        ...(!params.relayTerminalProjection && crossBrokerTerminalRelayConfig
          ? {
              relayTerminalProjection: async (projection) => {
                const client = getCrossBrokerTerminalRelayClient();
                if (!client?.relayTerminalProjection) {
                  throw new Error("origin broker client does not expose relayTerminalProjection");
                }
                await client.relayTerminalProjection(projection as unknown as Record<string, unknown>);
                return {
                  accepted: true,
                  reason: `origin broker ${crossBrokerTerminalRelayConfig.label ?? crossBrokerTerminalRelayConfig.baseUrl} accepted bounded terminal projection`,
                };
              },
              ...(params.handoffBrokerId ?? crossBrokerTerminalRelayConfig.handoffBrokerId
                ? { handoffBrokerId: params.handoffBrokerId ?? crossBrokerTerminalRelayConfig.handoffBrokerId }
                : {}),
              ...(params.terminalProjectionMaxSummaryChars ?? crossBrokerTerminalRelayConfig.maxSummaryChars
                ? { terminalProjectionMaxSummaryChars: params.terminalProjectionMaxSummaryChars ?? crossBrokerTerminalRelayConfig.maxSummaryChars }
                : {}),
            }
          : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    });
  let rawClient: RawBrokerClient | undefined;
  let clientError: Error | undefined;
  let operatorBridge: A2AOperatorEventBridge | undefined;

  function getRawClient(): RawBrokerClient | null {
    if (rawClient) return rawClient;
    try {
      rawClient = createClient(config);
      clientError = undefined;
      return rawClient;
    } catch (error) {
      clientError = error instanceof Error ? error : new Error(String(error));
      return null;
    }
  }

  function respondBrokerUnavailable(opts: GatewayRequestHandlerOptions): void {
    const message = clientError?.message ?? "a2a broker client not initialized";
    opts.respond(false, undefined, a2aError(A2AErrorCodes.NOT_FOUND, message));
  }

  function ensureOperatorEventBridge(params: { cursor?: string } = {}): { bridge?: A2AOperatorEventBridge; disabled?: unknown } {
    if (!resolvedConfig.enabled) {
      return {
        disabled: buildDisabledA2AOperatorEventBridgeState({
          cursor: params.cursor,
          note: "Standalone A2A broker adapter is disabled",
        }),
      };
    }
    if (!resolvedConfig.operatorEventsEnabled) {
      return {
        disabled: buildDisabledA2AOperatorEventBridgeState({
          cursor: params.cursor,
          note:
            "Broker operator event bridge is disabled; set plugins.entries.a2a-broker-adapter.config.operatorEvents.enabled=true",
        }),
      };
    }

    const client = getRawClient();
    if (!client) {
      return {
        disabled: buildUnavailableA2AOperatorEventBridgeState({
          message: clientError?.message ?? "a2a broker client not initialized",
          cursor: params.cursor,
          ...(deps.now ? { now: deps.now } : {}),
        }),
      };
    }

    operatorBridge ??= createOperatorEventBridgeFactory({
      broker: client,
      ...(localBrokerId ? { handoffBrokerId: localBrokerId } : {}),
    });
    ensureCrossBridgesStarted();
    return { bridge: operatorBridge };
  }

  function ensureCrossBridgesStarted(): void {
    initCrossBrokers();
    startCrossBridges();
  }

  function getCrossBridgeStates(): Record<string, unknown> {
    const crossStates: Record<string, unknown> = {};
    for (const [key, bridge] of crossBridges) {
      try { crossStates[key] = bridge.getState(); } catch { /* best-effort */ }
    }
    return crossStates;
  }

  function getOperatorBridgeState(params: { cursor?: string }): unknown {
    const ensured = ensureOperatorEventBridge(params);
    if (ensured.disabled) return ensured.disabled;
    const primaryState = ensured.bridge!.getState({ cursor: params.cursor });
    const crossStates = getCrossBridgeStates();
    return {
      ...(primaryState as Record<string, unknown>),
      ...(Object.keys(crossStates).length ? { crossBrokers: crossStates } : {}),
    };
  }

  function buildNotificationPreflightConfig(params: A2AMonitorStatusParams["operatorEvents"]): A2ABrokerAdapterPluginRuntimeConfig {
    const entry = config.plugins?.entries?.["a2a-broker-adapter"];
    const entryConfig = entry?.config ?? {};
    const currentOperatorEvents = asPlainRecord(entryConfig.operatorEvents) ?? {};
    const requestedNotification = asPlainRecord(params?.notification);
    const currentNotification = asPlainRecord(currentOperatorEvents.notification);
    const operatorEvents = {
      ...currentOperatorEvents,
      ...(params?.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(requestedNotification
        ? { notification: { ...(currentNotification ?? {}), ...requestedNotification } }
        : {}),
    };

    return {
      ...config,
      plugins: {
        ...(config.plugins ?? {}),
        entries: {
          ...(config.plugins?.entries ?? {}),
          "a2a-broker-adapter": {
            ...(entry ?? {}),
            enabled: entry?.enabled ?? true,
            config: {
              ...entryConfig,
              operatorEvents,
            },
          },
        },
      },
    };
  }

  async function readTerminalOutboxHistoryForPreflight(
    params: A2AMonitorStatusParams["operatorEvents"],
  ): Promise<Record<string, unknown> | undefined> {
    const currentOperatorEvents = readOperatorEventsConfig(config);
    const afterId = readString(params?.terminalOutboxCursor)
      ?? readString(params?.cursor)
      ?? readString(currentOperatorEvents?.terminalOutboxCursor);
    if (!afterId) return undefined;

    const client = getRawClient() as A2AOperatorEventBridgeBrokerClient | undefined;
    if (!client?.listTerminalOutbox) {
      return { error: "broker client does not expose listTerminalOutbox for no-live terminal-outbox history preflight" };
    }

    const requestedLimit = typeof params?.terminalOutboxLimit === "number" && Number.isFinite(params.terminalOutboxLimit)
      ? Math.floor(params.terminalOutboxLimit)
      : 25;
    const limit = Math.min(100, Math.max(1, requestedLimit));
    try {
      const response = await client.listTerminalOutbox({
        afterId,
        limit,
        reconcileUnacked: false,
      });
      return response as unknown as Record<string, unknown>;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    startOperatorEventBridge(): unknown {
      const ensured = ensureOperatorEventBridge();
      if (ensured.disabled) return ensured.disabled;
      const primaryState = ensured.bridge!.getState();
      const crossStates = getCrossBridgeStates();
      return {
        ...(primaryState as Record<string, unknown>),
        ...(Object.keys(crossStates).length ? { crossBrokers: crossStates } : {}),
      };
    },

    shutdownOperatorEventBridge(): void {
      operatorBridge?.shutdown();
      operatorBridge = undefined;
      shutdownCrossBridges();
    },

    handleA2AAlertsList: async (opts: GatewayRequestHandlerOptions): Promise<void> => {
      const check = validateParams(opts.params, validateA2AAlertsListParams, "a2a.alerts.list");
      if (!check.valid) {
        opts.respond(false, undefined, check.error);
        return;
      }
      const client = getRawClient();
      if (!client) {
        respondBrokerUnavailable(opts);
        return;
      }
      try {
        const alerts = await client.getAlerts();
        opts.respond(true, alerts);
      } catch (err) {
        const error = toGatewayError(err);
        opts.respond(
          false,
          undefined,
          a2aError(A2AErrorCodes.INTERNAL, `a2a.alerts.list failed: ${error}`),
        );
      }
    },

    handleA2AMonitorStatus: async (opts: GatewayRequestHandlerOptions): Promise<void> => {
      const check = validateParams(opts.params, validateA2AMonitorStatusParams, "a2a.monitor.status");
      if (!check.valid) {
        opts.respond(false, undefined, check.error);
        return;
      }
      if (!check.data.taskId && check.data.operatorEvents?.preflight === true) {
        const existingTerminalOutbox = operatorBridge
          ? (operatorBridge.getState().operator.terminalOutbox as Record<string, unknown> | undefined)
          : undefined;
        const terminalOutboxHistory = await readTerminalOutboxHistoryForPreflight(check.data.operatorEvents);
        const preflight = await preflightA2AOperatorNotificationRuntime(
          buildNotificationPreflightConfig(check.data.operatorEvents),
          deps.runtime,
          {
            ...(existingTerminalOutbox ? { terminalOutbox: existingTerminalOutbox } : {}),
            ...(terminalOutboxHistory ? { terminalOutboxHistory } : {}),
          },
        );
        opts.respond(
          true,
          {
            kind: "a2a.operator.notification.preflight",
            mode: "no-live",
            liveSendPerformed: false,
            terminalOutboxAckPerformed: false,
            providerSendPerformed: false,
            safeToRestartGateway: preflight.safeToRestartGateway,
            decision: preflight.safeToRestartGateway ? "GO" : "BLOCK",
            preflight,
            recommendedNextAction: preflight.safeToRestartGateway
              ? "Operator may approve the bounded Gateway restart/live canary separately; this preflight did not send or ACK."
              : "Fix the reported config/runtime receipt blockers before Gateway restart or live Terminal Brief canary.",
          },
        );
        return;
      }
      if (!check.data.taskId && check.data.operatorEvents?.enabled === true) {
        const bridgeState = getOperatorBridgeState({ cursor: check.data.operatorEvents.cursor }) as A2AOperatorEventBridgeState;
        // Build pressure + hygiene for gate-readiness when bridge state is available
        const rawClient = getRawClient();
        const health = rawClient
          ? await getBrokerHealthForWarningProjection(rawClient)
          : undefined;
        const operatorStatus = projectA2AOperatorStatus(bridgeState, health);
        opts.respond(
          true,
          {
            ...(bridgeState as Record<string, unknown>),
            operatorStatus,
          },
        );
        return;
      }

      const client = getRawClient();
      if (!client) {
        respondBrokerUnavailable(opts);
        return;
      }
      try {
        const health = await getBrokerHealthForWarningProjection(client);
        if (check.data.taskId) {
          // Single-task diagnostics
          const diagnostics = await client.getTaskDiagnostics(check.data.taskId);
          opts.respond(true, projectBrokerAuditWarnings(diagnostics, health));
        } else {
          // Bulk diagnostics scan
          const diagnostics = await client.listDiagnostics();
          opts.respond(true, projectBrokerAuditWarnings(diagnostics, health));
        }
      } catch (err) {
        if (err instanceof A2ABrokerClientError && err.status === 404) {
          opts.respond(
            false,
            undefined,
            a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.taskId}`),
          );
          return;
        }
        const error = toGatewayError(err);
        opts.respond(
          false,
          undefined,
          a2aError(A2AErrorCodes.INTERNAL, `a2a.monitor.status failed: ${error}`),
        );
      }
    },
  };
}

function toGatewayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getBrokerHealthForWarningProjection(
  client: { health?: () => Promise<unknown> },
): Promise<unknown> {
  if (typeof client.health !== "function") return undefined;
  try {
    return await client.health();
  } catch {
    // Monitoring status should keep its existing diagnostics semantics even when
    // the optional health-side warning metadata is temporarily unavailable.
    return undefined;
  }
}

export function projectBrokerAuditWarnings(diagnostics: unknown, health: unknown): unknown {
  const warning = buildBrokerAuditBottleneckWarning(health);
  const terminalReceiptGaps = buildBrokerTerminalReceiptGapProjections(diagnostics);
  const receiptWarning = buildBrokerTerminalReceiptGapWarning(terminalReceiptGaps);
  const noLiveRehearsal = buildBrokerNoLiveRehearsalProjection(diagnostics);
  const noLiveRehearsalWarning = buildBrokerNoLiveRehearsalWarning(noLiveRehearsal);
  const liveReadiness = buildBrokerLiveReadinessProjection(diagnostics);
  const liveReadinessWarning = buildBrokerLiveReadinessWarning(liveReadiness);
  const runtimeOwner = buildBrokerRuntimeOwnerMetadata(health);
  const buildInfo = buildBrokerBuildInfoMetadata(health);
  const protocolProfile = buildBrokerProtocolProfile(health);
  if (!isPlainRecord(diagnostics)) return diagnostics;

  const existingWarnings = Array.isArray(diagnostics.pluginWarnings)
    ? diagnostics.pluginWarnings
    : [];
  const projectedDiagnostics = noLiveRehearsal
    ? stripBrokerNoLiveRehearsalManifests(diagnostics)
    : diagnostics;
  const pluginWarnings = [
    ...existingWarnings,
    ...(warning ? [warning] : []),
    ...(receiptWarning ? [receiptWarning] : []),
    ...(noLiveRehearsalWarning ? [noLiveRehearsalWarning] : []),
    ...(liveReadinessWarning ? [liveReadinessWarning] : []),
  ];
  return {
    ...projectedDiagnostics,
    ...(pluginWarnings.length ? { pluginWarnings } : {}),
    ...(terminalReceiptGaps.length ? { terminalReceiptGaps } : {}),
    ...(noLiveRehearsal ? { noLiveRehearsal } : {}),
    ...(liveReadiness ? { liveReadiness } : {}),
    ...(runtimeOwner ? { brokerRuntimeOwner: runtimeOwner } : {}),
    brokerBuildInfo: buildInfo,
    ...(protocolProfile ? { brokerProtocolProfile: protocolProfile } : {}),
  };
}

export function buildBrokerLiveReadinessProjection(
  diagnostics: unknown,
): A2ABrokerLiveReadinessProjection | undefined {
  if (!isPlainRecord(diagnostics)) return undefined;
  const source = findLiveReadinessSource(diagnostics);
  if (!source) return undefined;

  const canaryResults = readLiveReadinessCanaryResults(source);
  const evidenceAcceptance = readLiveReadinessEvidenceAcceptance(source);
  const queueSignals = readLiveReadinessQueueSignals(source);
  const hasBlockedCanary = canaryResults.some((result) => result.status === "blocked");
  const hasBlockedEvidence = evidenceAcceptance.some((result) => result.status !== "accepted");
  const status = hasBlockedCanary || hasBlockedEvidence || queueSignals.status === "blocked" ? "blocked" : "ready";
  const runId = firstSafeString(source.runId, source.run, source.traceId, getNested(source, ["metadata", "runId"]));

  return {
    mode: "release-dryrun/no-live",
    status,
    ...(runId ? { runId } : {}),
    canaryResults,
    evidenceAcceptance,
    queueSignals,
    safeOperations: {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    },
  };
}

function buildBrokerLiveReadinessWarning(
  projection: A2ABrokerLiveReadinessProjection | undefined,
): A2ABrokerLiveReadinessWarning | undefined {
  if (!projection || projection.status !== "blocked") return undefined;
  return {
    code: "live_readiness_blocked",
    severity: "warn",
    source: "broker.liveReadiness",
    message: "Live-readiness monitor has blocked canary, evidence, stale, timed_out, or active queue signals.",
  };
}

function findLiveReadinessSource(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [
    root.liveReadiness,
    root.liveReadinessProjection,
    root.liveReadinessMonitor,
    getNested(root, ["diagnostics", "liveReadiness"]),
    getNested(root, ["monitor", "liveReadiness"]),
    findNoLiveRehearsalManifest(root),
  ];
  for (const candidate of candidates) {
    if (!isPlainRecord(candidate)) continue;
    const mode = firstString(candidate.mode, candidate.safetyMode, candidate.kind);
    if (
      mode === "release-dryrun/no-live" ||
      mode === "live-readiness" ||
      candidate.liveReadiness === true ||
      Array.isArray(candidate.evidenceAcceptance) ||
      Array.isArray(candidate.canaryResults)
    ) return candidate;
  }
  return undefined;
}

function readLiveReadinessCanaryResults(
  source: Record<string, unknown>,
): A2ABrokerLiveReadinessProjection["canaryResults"] {
  const raw = firstArray(source.canaryResults, source.canary, source.verifierResults, source.gates);
  if (!raw) return [];
  return raw.filter(isPlainRecord).map((record) => ({
    code: firstSafeString(record.code, record.name, record.id) ?? "canary",
    status: normalizeFindingStatus(firstSafeString(record.status, record.result, record.state)),
    message: firstSafeReason(record.message, record.reason, record.summary) ?? "live-readiness canary result",
  })).slice(0, 25);
}

function readLiveReadinessEvidenceAcceptance(
  source: Record<string, unknown>,
): A2ABrokerLiveReadinessProjection["evidenceAcceptance"] {
  const raw = firstArray(
    source.evidenceAcceptance,
    source.evidenceResults,
    source.verifierEvidence,
    source.canonicalEvidence,
    getNested(source, ["evidence", "acceptance"]),
  );
  if (!raw) return [];
  return raw.filter(isPlainRecord).map((record) => {
    const kind = normalizeEvidenceKind(firstSafeString(record.kind, record.marker, record.type));
    const status = normalizeEvidenceAcceptanceStatus(firstSafeString(record.status, record.result, record.state), kind);
    const taskId = firstSafeString(record.taskId, record.id);
    const issue = firstSafeString(record.issue, record.issueUrl, record.issueRef);
    const url = firstSafeUrl(record.url, record.prUrl, record.doneUrl, record.blockUrl, record.evidenceUrl);
    return {
      kind,
      status,
      ...(taskId ? { taskId } : {}),
      ...(issue ? { issue } : {}),
      ...(url ? { url } : {}),
      message: firstSafeReason(record.message, record.reason, record.summary) ?? buildEvidenceAcceptanceMessage(kind, status),
    };
  }).slice(0, 25);
}

function readLiveReadinessQueueSignals(
  source: Record<string, unknown>,
): A2ABrokerLiveReadinessProjection["queueSignals"] {
  const queue = isPlainRecord(source.queueSignals) ? source.queueSignals : isPlainRecord(source.queue) ? source.queue : source;
  const queued = firstNonNegativeInteger(queue.queued, queue.queuedCount, queue.pending) ?? 0;
  const claimed = firstNonNegativeInteger(queue.claimed, queue.claimedCount) ?? 0;
  const running = firstNonNegativeInteger(queue.running, queue.runningCount, queue.inProgress) ?? 0;
  const stale = firstNonNegativeInteger(queue.stale, queue.staleCount, queue.staleTasks) ?? 0;
  const timedOut = firstNonNegativeInteger(queue.timedOut, queue.timed_out, queue.timeout, queue.timedOutCount) ?? 0;
  const active = queued + claimed + running;
  const messages = [
    active ? `active tasks: queued=${queued}, claimed=${claimed}, running=${running}` : undefined,
    stale ? `stale workers/tasks (no recent heartbeat): ${stale} — operator review recommended` : undefined,
    timedOut ? `timed-out tasks (exceeded deadline): ${timedOut} — may need cancellation` : undefined,
  ].filter((message): message is string => Boolean(message)).slice(0, 10);
  return {
    status: active || stale || timedOut ? "blocked" : "ready",
    queued,
    claimed,
    running,
    stale,
    timedOut,
    messages,
  };
}

export function buildBrokerNoLiveRehearsalProjection(
  diagnostics: unknown,
): A2ABrokerNoLiveRehearsalProjection | undefined {
  if (!isPlainRecord(diagnostics)) return undefined;
  const manifest = findNoLiveRehearsalManifest(diagnostics);
  if (!manifest) return undefined;

  const missingUnsafeEvidenceFields = collectMissingUnsafeEvidenceFields(manifest);
  const receiptStates = readNoLiveReceiptStates(manifest);
  const gateFindings = readNoLiveFindings(manifest, ["gateFindings", "gates", "receiptGates"]);
  const auditFindings = readNoLiveFindings(manifest, ["auditFindings", "audit", "ackAuditDecisions"]);
  const hasBlockedFinding = [...gateFindings, ...auditFindings].some((finding) => finding.status === "blocked");
  const status = missingUnsafeEvidenceFields.length || hasBlockedFinding ? "blocked" : "ready";
  const manifestId = firstSafeString(manifest.manifestId, manifest.id);
  const runId = firstSafeString(manifest.runId, manifest.run, manifest.traceId);
  return {
    mode: "release-dryrun/no-live",
    status,
    ...(manifestId ? { manifestId } : {}),
    ...(runId ? { runId } : {}),
    receiptStates,
    gateFindings,
    auditFindings,
    missingUnsafeEvidenceFields,
    safeOperations: {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    },
  };
}

function stripBrokerNoLiveRehearsalManifests(diagnostics: Record<string, unknown>): Record<string, unknown> {
  const {
    noLiveRehearsalManifest: _noLiveRehearsalManifest,
    rehearsalManifest: _rehearsalManifest,
    noLiveRehearsal: _noLiveRehearsal,
    ...safeDiagnostics
  } = diagnostics;
  return safeDiagnostics;
}

function buildBrokerNoLiveRehearsalWarning(
  projection: A2ABrokerNoLiveRehearsalProjection | undefined,
): A2ABrokerNoLiveRehearsalWarning | undefined {
  if (!projection || projection.status !== "blocked") return undefined;
  return {
    code: "no_live_rehearsal_blocked",
    severity: "warn",
    source: "broker.rehearsalManifest",
    message: "No-live rehearsal manifest is missing required safe evidence or contains blocked gate/audit findings.",
    missingUnsafeEvidenceFields: projection.missingUnsafeEvidenceFields,
  };
}

function findNoLiveRehearsalManifest(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [
    root.noLiveRehearsalManifest,
    root.rehearsalManifest,
    root.noLiveRehearsal,
    getNested(root, ["diagnostics", "noLiveRehearsalManifest"]),
    getNested(root, ["diagnostics", "rehearsalManifest"]),
    getNested(root, ["rehearsal", "manifest"]),
  ];
  for (const candidate of candidates) {
    if (!isPlainRecord(candidate)) continue;
    const mode = firstString(candidate.mode, candidate.safetyMode, candidate.kind);
    if (mode === "release-dryrun/no-live" || mode === "no-live" || candidate.noLive === true) return candidate;
  }
  return undefined;
}

function collectMissingUnsafeEvidenceFields(manifest: Record<string, unknown>): string[] {
  const requiredFalse: Array<[string, unknown]> = [
    ["safeOperations.liveSend", getNested(manifest, ["safeOperations", "liveSend"])],
    ["safeOperations.terminalOutboxAck", getNested(manifest, ["safeOperations", "terminalOutboxAck"])],
    ["safeOperations.gatewayRestart", getNested(manifest, ["safeOperations", "gatewayRestart"])],
    ["safeOperations.productionDeploy", getNested(manifest, ["safeOperations", "productionDeploy"])],
    ["safeOperations.providerSend", getNested(manifest, ["safeOperations", "providerSend"])],
    ["receiptGate.terminalAckEligible", getNested(manifest, ["receiptGate", "terminalAckEligible"])],
  ];
  const missing = requiredFalse.flatMap(([field, value]) => value === false ? [] : [field]);
  if (getNested(manifest, ["receiptGate", "providerGatewaySendSuccess"]) !== "not_ack_evidence") {
    missing.push("receiptGate.providerGatewaySendSuccess");
  }
  return missing;
}

function readNoLiveReceiptStates(manifest: Record<string, unknown>): A2ABrokerNoLiveRehearsalProjection["receiptStates"] {
  const raw = firstArray(
    manifest.receiptStates,
    manifest.receipts,
    manifest.terminalReceipts,
    getNested(manifest, ["receiptGate", "receiptStates"]),
  );
  if (!raw) return [];
  return raw.filter(isPlainRecord).map((record) => {
    const state = normalizeNoLiveReceiptState(firstSafeString(record.state, record.status, record.receiptStatus));
    const taskId = firstSafeString(record.taskId, record.id);
    return {
      ...(taskId ? { taskId } : {}),
      state,
      terminalAckEligible: record.terminalAckEligible === true,
      reason: firstSafeReason(record.reason, record.message) ?? buildNoLiveReceiptReason(state),
    };
  }).slice(0, 25);
}

function readNoLiveFindings(
  manifest: Record<string, unknown>,
  keys: string[],
): A2ABrokerNoLiveRehearsalProjection["gateFindings"] {
  const raw = firstArray(...keys.map((key) => manifest[key]));
  if (!raw) return [];
  return raw.filter(isPlainRecord).map((record) => ({
    code: firstSafeString(record.code, record.name, record.id) ?? "finding",
    status: normalizeFindingStatus(firstSafeString(record.status, record.result)),
    message: firstSafeReason(record.message, record.reason, record.summary) ?? "no-live rehearsal finding",
  })).slice(0, 25);
}

export function buildBrokerTerminalReceiptGapProjections(
  diagnostics: unknown,
): A2ABrokerTerminalReceiptGapProjection[] {
  if (!isPlainRecord(diagnostics)) return [];
  const byTask = new Map<string, A2ABrokerTerminalReceiptGapProjection>();

  for (const record of readTerminalReceiptGapRecords(diagnostics)) {
    const projection = normalizeBrokerTerminalReceiptGapProjection(record);
    if (!projection) continue;
    byTask.set(projection.taskId, projection);
  }

  return [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)).slice(0, 25);
}

function buildBrokerTerminalReceiptGapWarning(
  projections: A2ABrokerTerminalReceiptGapProjection[],
): A2ABrokerTerminalReceiptGapWarning | undefined {
  const gaps = projections.filter((projection) => projection.receiptGapStatus !== "confirmed");
  if (!gaps.length) return undefined;
  return {
    code: "terminal_receipt_gap",
    severity: "warn",
    source: "broker.diagnostics",
    message: "Terminal task receipt/evidence is not operator-confirmed; provider send success is not terminal ACK evidence.",
    count: gaps.length,
    taskIds: gaps.map((gap) => gap.taskId).slice(0, 10),
  };
}

function readTerminalReceiptGapRecords(root: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pushRecord = (value: unknown) => {
    if (isPlainRecord(value)) records.push(value);
  };
  const pushArray = (value: unknown) => {
    if (Array.isArray(value)) records.push(...value.filter(isPlainRecord));
  };

  pushRecord(root.terminalEvent);
  pushRecord(root.terminalReceipt);
  pushRecord(root.receipt);
  pushArray(root.terminalReceipts);
  pushArray(root.receiptGaps);
  pushArray(root.terminalReceiptGaps);
  pushArray(root.terminalOutbox);
  pushArray(root.events);
  pushArray(root.outboxEvents);
  pushArray(root.tasks);
  pushArray(root.items);
  pushArray(root.diagnostics);
  pushRecord(root.task);
  if (!records.length) records.push(root);
  return records;
}

function normalizeBrokerTerminalReceiptGapProjection(
  record: Record<string, unknown>,
): A2ABrokerTerminalReceiptGapProjection | undefined {
  const task = isPlainRecord(record.task) ? record.task : undefined;
  const metadata = isPlainRecord(record.metadata) ? record.metadata : undefined;
  const receipt = isPlainRecord(record.receipt) ? record.receipt : undefined;
  const ack = isPlainRecord(record.ack) ? record.ack : undefined;
  const ackAudit = isPlainRecord(record.ackAudit) ? record.ackAudit : undefined;
  const delivery = isPlainRecord(record.delivery) ? record.delivery : undefined;
  const payload = isPlainRecord(record.payload) ? record.payload : undefined;
  const roots = [ackAudit, record, metadata, receipt, ack, delivery, payload].filter(isPlainRecord);

  const taskId = firstSafeString(record.taskId, record.a2aTaskId, task?.id, metadata?.taskId, payload?.taskId, record.id);
  if (!taskId) return undefined;

  const status = firstSafeString(record.status, record.type, task && isPlainRecord(task.status) ? task.status.state : undefined, payload?.status);
  const receiptMode = readConfirmedTerminalReceiptMode(roots);
  const explicitGap = readExplicitTerminalReceiptGapStatus(roots);
  const terminalLike = isTerminalDiagnosticRecord(record, status);
  const receiptGapStatus = explicitGap ?? (receiptMode ? "confirmed" : terminalLike ? "missing" : undefined);
  if (!receiptGapStatus) return undefined;
  const receiptState = normalizeOperatorReceiptProjectionState(roots, status, receiptMode, receiptGapStatus);
  const providerDeliveryState = readProviderDeliveryState(roots);
  const operatorReceiptState = normalizeOperatorVisibleReceiptState(receiptGapStatus);
  const brokerReceiptClassification = readBrokerReceiptClassification(roots);

  const terminalAckEligible = Boolean(receiptMode) && receiptGapStatus === "confirmed";
  return {
    taskId,
    ...(status ? { status } : {}),
    receiptState,
    ...(providerDeliveryState ? { providerDeliveryState } : {}),
    receiptStatus: receiptGapStatus === "confirmed" ? "received" : "pending",
    receiptGapStatus,
    operatorReceiptState,
    operatorReceiptLabel: buildOperatorReceiptLabel(operatorReceiptState),
    ...(brokerReceiptClassification ? { brokerReceiptClassification } : {}),
    terminalAckEligible,
    reason: buildTerminalReceiptGapReason(receiptGapStatus),
  };
}

function readConfirmedTerminalReceiptMode(
  roots: Record<string, unknown>[],
): "current_session_visible" | "manual_operator_receipt" | undefined {
  for (const root of roots) {
    if (root.current_session_visible === true || root.currentSessionVisible === true) return "current_session_visible";
    if (root.manual_operator_receipt === true || root.manualOperatorReceipt === true) return "manual_operator_receipt";
    const mode = firstSafeString(root.receiptMode, root.receiptProjection, root.projection, root.mode, root.kind, root.evidence);
    if (mode === "current_session_visible" || mode === "operator_visible" || mode === "operator-visible") return "current_session_visible";
    if (mode === "manual_operator_receipt" || mode === "operator_confirmed" || mode === "operator-confirmed") return "manual_operator_receipt";
  }
  return undefined;
}

function readExplicitTerminalReceiptGapStatus(
  roots: Record<string, unknown>[],
): A2ABrokerTerminalReceiptGapProjection["receiptGapStatus"] | undefined {
  for (const root of roots) {
    const decision = firstSafeString(root.decision)?.toLowerCase();
    if (["duplicate_suppressed", "duplicate-suppressed", "duplicate_delivery_suppressed", "suppress_duplicate", "duplicate"].includes(decision ?? "")) return "duplicate_suppressed";
    const raw = firstSafeString(
      root.receiptGapStatus,
      root.receipt_gap_status,
      root.operatorReceiptStatus,
      root.operator_receipt_status,
      root.terminalReceiptStatus,
      root.terminal_receipt_status,
      root.receiptClassification,
      root.receipt_classification,
      root.classification,
      root.receiptStatus,
      root.receipt_status,
    )?.toLowerCase();
    if (!raw) continue;
    if (["confirmed", "receipt_confirmed", "received", "visible", "operator_visible", "operator-visible", "operator_confirmed"].includes(raw)) return "confirmed";
    if (["provider_delivered", "provider-delivered", "provider-delivered-if-known", "delivered", "provider_sent", "provider-sent", "sent", "accepted", "started", "produced", "pending"].includes(raw)) return "missing";
    if (["missing", "waiting", "unconfirmed", "not_received", "receipt_missing", "pending_receipt", "hold_unacked"].includes(raw)) return "missing";
    if (["timed_out", "timeout", "timed-out"].includes(raw)) return "timed_out";
    if (["stale", "expired", "stale_timed_out", "timed_out_stale", "timed-out-stale"].includes(raw)) return "stale";
    if (["duplicate_suppressed", "duplicate-suppressed", "duplicate_delivery_suppressed", "suppress_duplicate", "duplicate"].includes(raw)) return "duplicate_suppressed";
    if (["failed", "failure", "error", "rejected", "undeliverable"].includes(raw)) return "failed";
  }
  return undefined;
}

function isTerminalDiagnosticRecord(record: Record<string, unknown>, status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  if (normalized && ["succeeded", "success", "completed", "done", "failed", "failure", "blocked", "canceled", "cancelled"].includes(normalized)) {
    return true;
  }
  const providerStatus = firstSafeString(record.providerSendStatus, record.providerGatewaySendStatus, getNested(record, ["delivery", "status"]))?.toLowerCase();
  return providerStatus === "sent" || providerStatus === "provider_sent" || providerStatus === "accepted";
}

function normalizeOperatorReceiptProjectionState(
  roots: Record<string, unknown>[],
  brokerStatus: string | undefined,
  receiptMode: "current_session_visible" | "manual_operator_receipt" | undefined,
  gapStatus: A2ABrokerTerminalReceiptGapProjection["receiptGapStatus"],
): A2AOperatorReceiptProjectionState {
  if (receiptMode && gapStatus === "confirmed") return "operator-visible";
  if (gapStatus === "failed") return "failed";
  if (gapStatus === "timed_out") return "timed_out";
  if (gapStatus === "stale") return "stale";
  if (gapStatus === "duplicate_suppressed") return "pending";

  for (const root of roots) {
    const normalized = firstSafeString(
      root.receiptState,
      root.receipt_state,
      root.operatorReceiptState,
      root.operator_receipt_state,
      root.terminalReceiptState,
      root.terminal_receipt_state,
      root.terminalReceiptStatus,
      root.terminal_receipt_status,
      root.receiptClassification,
      root.receipt_classification,
      root.classification,
      root.receiptStatus,
      root.receipt_status,
      root.providerDeliveryStatus,
      root.provider_delivery_status,
      root.providerSendStatus,
      root.provider_send_status,
      root.providerGatewaySendStatus,
      root.provider_gateway_send_status,
      root.status,
    )?.toLowerCase();
    const state = normalizeOperatorReceiptStateString(normalized);
    if (state) return state;
  }

  const fallback = normalizeOperatorReceiptStateString(brokerStatus?.toLowerCase());
  return fallback ?? (gapStatus === "missing" ? "pending" : "timed_out");
}

function normalizeOperatorReceiptStateString(value: string | undefined): A2AOperatorReceiptProjectionState | undefined {
  if (!value) return undefined;
  if (value === "accepted" || value === "queued" || value === "started" || value === "produced") return "accepted";
  if (value === "sent" || value === "provider_sent" || value === "provider-sent") return "sent";
  if (["provider_delivered", "provider-delivered", "provider-delivered-if-known", "delivered"].includes(value)) {
    return "provider-delivered-if-known";
  }
  if (["operator_visible", "operator-visible", "visible", "received", "receipt_confirmed", "confirmed", "operator_confirmed"].includes(value)) {
    return "operator-visible";
  }
  if (value === "timed_out" || value === "timeout" || value === "timed-out") return "timed_out";
  if (value === "stale" || value === "expired") return "stale";
  if (["failed", "failure", "error", "rejected", "undeliverable"].includes(value)) return "failed";
  return undefined;
}

function buildTerminalReceiptGapReason(
  status: A2ABrokerTerminalReceiptGapProjection["receiptGapStatus"],
): string {
  if (status === "confirmed") return "receipt confirmed — terminal ack eligible";
  if (status === "failed") return "receipt failed — terminal ack blocked";
  if (status === "timed_out") return "receipt timed out — must refresh before ack";
  if (status === "stale") return "receipt stale — must refresh before ack";
  if (status === "duplicate_suppressed") return "duplicate suppressed — no receipt confirmation, ack blocked";
  return "no current-session/manual receipt — ack blocked";
}

function normalizeOperatorVisibleReceiptState(
  status: A2ABrokerTerminalReceiptGapProjection["receiptGapStatus"],
): A2AOperatorVisibleTerminalReceiptState {
  if (status === "confirmed") return "receipt_confirmed";
  if (status === "timed_out") return "timed_out";
  if (status === "stale") return "stale";
  if (status === "failed") return "failed";
  if (status === "duplicate_suppressed") return "duplicate_suppressed";
  return "pending_receipt";
}

function buildOperatorReceiptLabel(state: A2AOperatorVisibleTerminalReceiptState): string {
  switch (state) {
    case "receipt_confirmed":
      return "✓ receipt confirmed";
    case "timed_out":
      return "⏱ timed out";
    case "stale":
      return "⚠ stale receipt";
    case "failed":
      return "✗ receipt failed";
    case "duplicate_suppressed":
      return "⚠ duplicate suppressed";
    case "pending_receipt":
      return "⋯ pending receipt";
  }
}

function readProviderDeliveryState(
  roots: Record<string, unknown>[],
): Extract<A2AOperatorReceiptProjectionState, "accepted" | "sent" | "provider-delivered-if-known"> | undefined {
  for (const root of roots) {
    const state = normalizeOperatorReceiptStateString(firstString(
      root.providerDeliveryState,
      root.provider_delivery_state,
      root.providerDeliveryStatus,
      root.provider_delivery_status,
      root.providerSendStatus,
      root.provider_send_status,
      root.providerGatewaySendStatus,
      root.provider_gateway_send_status,
      root.terminalReceiptStatus,
      root.terminal_receipt_status,
      root.receiptStatus,
      root.receipt_status,
      root.status,
    )?.toLowerCase());
    if (state === "accepted" || state === "sent" || state === "provider-delivered-if-known") return state;
  }
  return undefined;
}

function readBrokerReceiptClassification(roots: Record<string, unknown>[]): string | undefined {
  for (const root of roots) {
    const classification = firstSafeString(
      root.receiptClassification,
      root.receipt_classification,
      root.operatorReceiptState,
      root.operator_receipt_state,
      root.terminalReceiptState,
      root.terminal_receipt_state,
      root.decision,
    );
    if (classification) return classification;
  }
  return undefined;
}

export function buildBrokerBuildInfoMetadata(
  health: unknown,
): A2ABrokerBuildInfoMetadata {
  const version = firstSafeBuildString(
    "version",
    getNested(health, ["buildInfo", "version"]),
    getNested(health, ["build", "version"]),
    getNested(health, ["release", "version"]),
    isPlainRecord(health) ? health.version : undefined,
  ) ?? "unknown";
  const revision = firstSafeBuildString(
    "revision",
    getNested(health, ["buildInfo", "revision"]),
    getNested(health, ["build", "revision"]),
    getNested(health, ["build", "commit"]),
    getNested(health, ["git", "revision"]),
    getNested(health, ["git", "sha"]),
    isPlainRecord(health) ? health.revision : undefined,
  ) ?? "unknown";
  const image = firstSafeBuildString(
    "image",
    getNested(health, ["buildInfo", "image"]),
    getNested(health, ["build", "image"]),
    getNested(health, ["container", "image"]),
    getNested(health, ["docker", "image"]),
    isPlainRecord(health) ? health.image : undefined,
  ) ?? "unknown";

  return {
    source: "broker.health",
    version,
    revision,
    image,
  };
}

export function buildBrokerRuntimeOwnerMetadata(
  health: unknown,
): A2ABrokerRuntimeOwnerMetadata | undefined {
  if (!isPlainRecord(health)) return undefined;

  const manager = firstSafeString(
    health.runtimeManager,
    health.manager,
    health.supervisor,
    health.orchestrator,
    getNested(health, ["runtimeOwner", "manager"]),
    getNested(health, ["runtime", "manager"]),
    getNested(health, ["process", "manager"]),
  );
  const service = firstSafeString(
    health.service,
    getNested(health, ["runtimeOwner", "service"]),
    getNested(health, ["runtime", "service"]),
  );
  const unit = firstSafeString(
    health.unit,
    health.systemdUnit,
    getNested(health, ["runtimeOwner", "unit"]),
    getNested(health, ["runtime", "unit"]),
  );
  const composeProject = firstSafeString(
    health.composeProject,
    getNested(health, ["runtimeOwner", "composeProject"]),
    getNested(health, ["runtime", "composeProject"]),
    getNested(health, ["docker", "composeProject"]),
  );
  const composeService = firstSafeString(
    health.composeService,
    getNested(health, ["runtimeOwner", "composeService"]),
    getNested(health, ["runtime", "composeService"]),
    getNested(health, ["docker", "composeService"]),
  );
  const containerName = firstSafeString(
    health.containerName,
    getNested(health, ["runtimeOwner", "containerName"]),
    getNested(health, ["runtime", "containerName"]),
    getNested(health, ["docker", "containerName"]),
  );

  if (!manager && !unit && !composeProject && !composeService && !containerName) {
    return undefined;
  }

  return {
    ...(manager ? { manager } : {}),
    ...(service ? { service } : {}),
    ...(unit ? { unit } : {}),
    ...(composeProject ? { composeProject } : {}),
    ...(composeService ? { composeService } : {}),
    ...(containerName ? { containerName } : {}),
  };
}

export function buildBrokerAuditBottleneckWarning(
  health: unknown,
): A2ABrokerAuditBottleneckWarning | undefined {
  if (!isPlainRecord(health)) return undefined;

  const auditRows = firstFiniteNumber(
    health.auditRows,
    getNested(health, ["audit", "auditRows"]),
    getNested(health, ["audit", "rows"]),
    getNested(health, ["diagnostics", "auditRows"]),
  );
  const maxAuditEvents = firstFiniteNumber(
    health.maxAuditEvents,
    getNested(health, ["audit", "maxAuditEvents"]),
    getNested(health, ["config", "maxAuditEvents"]),
    getNested(health, ["diagnostics", "maxAuditEvents"]),
  );
  const heartbeatRatio = normalizeRatio(
    firstFiniteNumber(
      health.heartbeatRatio,
      getNested(health, ["audit", "heartbeatRatio"]),
      getNested(health, ["diagnostics", "heartbeatRatio"]),
    ),
  );
  const healthLatencyMs = firstFiniteNumber(
    health.healthLatencyMs,
    health.latencyMs,
    getNested(health, ["diagnostics", "healthLatencyMs"]),
  );
  const dominantEventType = firstSafeString(
    health.dominantEventType,
    getNested(health, ["audit", "dominantEventType"]),
    getNested(health, ["diagnostics", "dominantEventType"]),
  );

  const overLimit =
    auditRows !== undefined && maxAuditEvents !== undefined && auditRows > maxAuditEvents;
  const heartbeatHeavy = heartbeatRatio !== undefined && heartbeatRatio >= 0.8;
  const slowHealth = healthLatencyMs !== undefined && healthLatencyMs >= 1_000;

  if (!overLimit && !heartbeatHeavy && !slowHealth) return undefined;

  return {
    code: "broker_audit_bottleneck",
    severity: "warn",
    source: "broker.health",
    message:
      "Broker audit table may be a status bottleneck; verify audit retention/pruning and heartbeat volume.",
    ...(auditRows !== undefined ? { auditRows } : {}),
    ...(maxAuditEvents !== undefined ? { maxAuditEvents } : {}),
    ...(heartbeatRatio !== undefined ? { heartbeatRatio } : {}),
    ...(healthLatencyMs !== undefined ? { healthLatencyMs } : {}),
    ...(dominantEventType ? { dominantEventType } : {}),
  };
}

// ── Broker protocol profile builder ──────────────────────────────────

/**
 * A2A broker protocol profile fields from the health endpoint.
 *
 * Extracts broker-advertised protocol information: protocolVersion,
 * capabilities (streaming, pushNotifications), input/output modes,
 * and transport hints (REST/gRPC/push). Returns undefined when the
 * health response contains no protocol profile fields.
 *
 * Terminal Brief / outbox ACK boundaries are separate from A2A push
 * notification conformance. Provider accepted/message-id evidence is
 * send-acceptance telemetry only and not operator-visible ACK.
 */
export function buildBrokerProtocolProfile(
  health: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(health)) return undefined;

  const protocol = isPlainRecord(health.protocol) ? health.protocol : undefined;
  if (!protocol) return undefined;

  const protocolVersion = firstSafeString(
    protocol.protocolVersion,
    protocol.version,
    protocol.target,
  );
  const capabilities = protocol.capabilities;
  const capabilitiesRecord = isPlainRecord(capabilities)
    ? {
        streaming:
          typeof capabilities.streaming === "boolean"
            ? capabilities.streaming
            : undefined,
        pushNotifications:
          typeof capabilities.pushNotifications === "boolean"
            ? capabilities.pushNotifications
            : undefined,
      }
    : undefined;
  const inputModes = Array.isArray(protocol.inputModes)
    ? protocol.inputModes.filter(
        (mode): mode is string => typeof mode === "string" && mode.trim().length > 0,
      )
    : undefined;
  const outputModes = Array.isArray(protocol.outputModes)
    ? protocol.outputModes.filter(
        (mode): mode is string => typeof mode === "string" && mode.trim().length > 0,
      )
    : undefined;
  const transportHints = isPlainRecord(protocol.transportHints)
    ? {
        rest: sanitizeTransportHint(protocol.transportHints.rest),
        grpc: sanitizeTransportHint(protocol.transportHints.grpc),
        push: sanitizeTransportHint(protocol.transportHints.push),
      }
    : undefined;

  const result: Record<string, unknown> = {};

  if (protocolVersion) result.protocolVersion = protocolVersion;
  if (capabilitiesRecord) result.capabilities = capabilitiesRecord;
  if (inputModes && inputModes.length > 0) result.inputModes = inputModes;
  if (outputModes && outputModes.length > 0) result.outputModes = outputModes;
  if (transportHints) result.transportHints = transportHints;

  // When only empty arrays are returned, treat as no-profile.
  if (Object.keys(result).length === 0) return undefined;

  return result;
}

function sanitizeTransportHint(
  value: unknown,
): "supported" | "unsupported" | "deferred" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().trim();
  if (normalized === "supported") return "supported";
  if (normalized === "unsupported") return "unsupported";
  if (normalized === "deferred") return "deferred";
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function normalizeNoLiveReceiptState(value: string | undefined): A2ABrokerNoLiveRehearsalProjection["receiptStates"][number]["state"] {
  return normalizeOperatorReceiptStateString(value?.toLowerCase()) ?? "pending";
}

function normalizeFindingStatus(value: string | undefined): "pass" | "blocked" {
  const normalized = value?.toLowerCase();
  return normalized === "pass" || normalized === "passed" || normalized === "ok" || normalized === "ready" ? "pass" : "blocked";
}

function buildNoLiveReceiptReason(state: A2ABrokerNoLiveRehearsalProjection["receiptStates"][number]["state"]): string {
  if (state === "operator-visible") return "operator-visible receipt evidence was projected without terminal ACK";
  if (state === "sent") return "provider send is projected only and is not terminal ACK evidence";
  if (state === "provider-delivered-if-known") return "provider delivery is informational only and is not operator-visible ACK evidence";
  if (state === "failed") return "receipt failed; terminal ACK remains blocked";
  if (state === "stale" || state === "timed_out") return "receipt is not fresh; terminal ACK remains blocked";
  return "receipt is pending in no-live rehearsal projection";
}

function normalizeEvidenceKind(value: string | undefined): A2ABrokerLiveReadinessProjection["evidenceAcceptance"][number]["kind"] {
  const normalized = value?.toLowerCase();
  if (normalized === "pr" || normalized === "pull_request" || normalized === "pull-request") return "PR";
  if (normalized === "done") return "Done";
  if (normalized === "block" || normalized === "blocked") return "Block";
  return "missing_evidence";
}

function normalizeEvidenceAcceptanceStatus(
  value: string | undefined,
  kind: A2ABrokerLiveReadinessProjection["evidenceAcceptance"][number]["kind"],
): A2ABrokerLiveReadinessProjection["evidenceAcceptance"][number]["status"] {
  const normalized = value?.toLowerCase();
  if (["accepted", "pass", "passed", "ok", "valid", "present"].includes(normalized ?? "")) return "accepted";
  if (["missing", "absent", "not_found", "no_evidence"].includes(normalized ?? "") || kind === "missing_evidence") return "missing";
  return "blocked";
}

function buildEvidenceAcceptanceMessage(
  kind: A2ABrokerLiveReadinessProjection["evidenceAcceptance"][number]["kind"],
  status: A2ABrokerLiveReadinessProjection["evidenceAcceptance"][number]["status"],
): string {
  if (status === "accepted") {
    if (kind === "PR") return "PR proof-of-change accepted by broker verifier";
    if (kind === "Done") return "Done evidence accepted (PR-less or read-only)";
    if (kind === "Block") return "Block evidence accepted (PR-less blocker)";
    return `${kind} evidence accepted by broker verifier`;
  }
  if (status === "missing") {
    if (kind === "PR") return "required PR evidence is missing — no proof-of-change";
    if (kind === "Done") return "required Done evidence is missing — no completion marker";
    if (kind === "Block") return "required Block evidence is missing — no blocker marker";
    return "required PR/Done/Block evidence is missing";
  }
  if (kind === "PR") return `PR evidence (${kind}) was rejected by broker verifier`;
  if (kind === "Done") return `Done evidence (${kind}) was rejected by broker verifier`;
  if (kind === "Block") return `Block evidence (${kind}) was rejected by broker verifier`;
  return `${kind} evidence was not accepted by broker verifier`;
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function firstSafeUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/(?:issues|pull)\/\d+(?:#issuecomment-\d+)?$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function firstSafeReason(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const redacted = redactUnsafeText(value.trim());
    if (redacted) return redacted.slice(0, 180);
  }
  return undefined;
}

function redactUnsafeText(value: string): string {
  return value
    .replace(new RegExp(String.fromCharCode(96, 96, 96) + "[\\s\\S]*?" + String.fromCharCode(96, 96, 96), "g"), "[redacted]")
    .replace(/\b(api[_ -]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]")
    .replace(/\b(rawPrompt|raw_prompt|prompt|sessionText|sessionContent)\b\s*[:=]\s*[^\n]+/gi, "$1: [redacted]")
    .replace(/\/(?:home|root|Users)\/[^\s,;]+/g, "[redacted-path]")
    .trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNested(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeRatio(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value > 1 ? value / 100 : value;
}

function firstSafeBuildString(kind: "version" | "revision" | "image", ...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > buildInfoMaxLength(kind)) continue;
    if (looksSensitive(trimmed)) continue;
    if (kind === "version" && /^[a-zA-Z0-9._:+-]{1,80}$/.test(trimmed)) return trimmed;
    if (kind === "revision" && /^[a-zA-Z0-9._:-]{4,80}$/.test(trimmed)) return trimmed;
    if (kind === "image" && /^[a-zA-Z0-9._:/@+-]{1,160}$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function buildInfoMaxLength(kind: "version" | "revision" | "image"): number {
  return kind === "image" ? 160 : 80;
}

function looksSensitive(value: string): boolean {
  return (
    /(?:token|secret|password|api[_-]?key)=/i.test(value) ||
    /(?:^|[/:._-])(?:token|secret|password|api[_-]?key)(?:$|[/:._-])/i.test(value) ||
    /^\/(?:home|root|Users)\//.test(value)
  );
}

function firstSafeString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (/^[a-zA-Z0-9_.:-]{1,80}$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

// ── Broker pressure & queue hygiene builders ─────────────────────────

function readQueueDepthFromSnapshot(snapshot: unknown): number | undefined {
  if (!isPlainRecord(snapshot)) return undefined;
  const summary = isPlainRecord(snapshot.summary) ? snapshot.summary : snapshot;
  return firstNonNegativeInteger(summary.queueDepth, summary.queue, summary.pendingTasks, summary.pendingCount);
}

function readWorkerProgressCounts(bridgeState: A2AOperatorEventBridgeState): {
  total: number;
  stale: number;
  activeTasks: number;
} {
  const workers = bridgeState.operator.workerProgress;
  if (!workers || typeof workers.counts !== "object") {
    return { total: 0, stale: 0, activeTasks: 0 };
  }
  const counts = workers.counts as Record<string, unknown>;
  return {
    total: firstNonNegativeInteger(counts.total) ?? 0,
    stale: (firstNonNegativeInteger(counts.stale) ?? 0) + (firstNonNegativeInteger(counts.unknown) ?? 0),
    activeTasks: firstNonNegativeInteger(counts.activeTasks) ?? 0,
  };
}

function readGitHubEvidenceHygiene(bridgeState: A2AOperatorEventBridgeState): {
  evidenceMissing: number;
  warnings: number;
} {
  const evidence = bridgeState.operator.githubEvidence;
  if (!evidence || typeof evidence.counts !== "object") {
    return { evidenceMissing: 0, warnings: 0 };
  }
  const counts = evidence.counts as Record<string, unknown>;
  return {
    evidenceMissing: firstNonNegativeInteger(counts.evidenceMissing) ?? 0,
    warnings: firstNonNegativeInteger(counts.warnings) ?? 0,
  };
}

function readTerminalReceiptGapCount(bridgeState: A2AOperatorEventBridgeState): number {
  const receipts = bridgeState.operator.terminalReceipts;
  if (!Array.isArray(receipts)) return 0;
  return receipts.filter((r) => r.receiptGapStatus !== "confirmed").length;
}

function readUnacknowledgedOutboxCount(bridgeState: A2AOperatorEventBridgeState): number {
  const outbox = bridgeState.operator.terminalOutbox;
  if (!outbox) return 0;
  const pending = (outbox as Record<string, unknown>).pendingUnacknowledged;
  if (Array.isArray(pending)) return pending.length;
  const lastPoll = isPlainRecord((outbox as Record<string, unknown>).lastPoll)
    ? (outbox as Record<string, unknown>).lastPoll as Record<string, unknown>
    : undefined;
  if (lastPoll) {
    return firstNonNegativeInteger(lastPoll.pendingUnacknowledged) ?? 0;
  }
  return 0;
}

function readQueueHygieneFromLiveSummary(liveSummary: unknown): {
  stale: number;
  timedOut: number;
  pending: number;
  claimedRunning: number;
} {
  if (!isPlainRecord(liveSummary)) {
    return { stale: 0, timedOut: 0, pending: 0, claimedRunning: 0 };
  }
  const s = liveSummary as Record<string, unknown>;
  return {
    stale: firstNonNegativeInteger(s.staleTasks, s.stale, s.staleCount) ?? 0,
    timedOut: firstNonNegativeInteger(s.timedOutTasks, s.timedOut, s.timed_out, s.timeoutCount) ?? 0,
    pending: firstNonNegativeInteger(s.pendingTasks, s.pending, s.queued, s.queuedCount) ?? 0,
    claimedRunning: firstNonNegativeInteger(s.claimedTasks, s.claimed, s.running, s.runningCount, s.inProgress) ?? 0,
  };
}

function readAuditPressureRatio(health: unknown): number | undefined {
  if (!isPlainRecord(health)) return undefined;
  const auditRows = firstFiniteNumber(
    health.auditRows,
    getNested(health, ["audit", "auditRows"]),
    getNested(health, ["audit", "rows"]),
  );
  const maxAuditEvents = firstFiniteNumber(
    health.maxAuditEvents,
    getNested(health, ["audit", "maxAuditEvents"]),
    getNested(health, ["config", "maxAuditEvents"]),
  );
  if (auditRows !== undefined && maxAuditEvents !== undefined && maxAuditEvents > 0) {
    return Math.min(1, auditRows / maxAuditEvents);
  }
  return undefined;
}

function readHealthLatencyMs(health: unknown): number | undefined {
  if (!isPlainRecord(health)) return undefined;
  return firstFiniteNumber(
    health.healthLatencyMs,
    health.latencyMs,
    getNested(health, ["diagnostics", "healthLatencyMs"]),
  );
}

/**
 * Project broker pressure from operator bridge state + health metadata.
 *
 * Extracts queue depth, audit pressure, worker health, and latency into
 * a single operator-readable pressure signal. Provider send/message-id
 * remains non-ACK evidence throughout.
 */
export function projectBrokerPressureOperatorStatus(
  bridgeState: A2AOperatorEventBridgeState,
  health?: unknown,
): A2ABrokerPressureProjection {
  const queueDepth = readQueueDepthFromSnapshot(bridgeState.operator.snapshot)
    ?? readQueueDepthFromSnapshot(bridgeState.operator.liveSummary)
    ?? 0;
  const workerCounts = readWorkerProgressCounts(bridgeState);
  const auditPressureRatio = readAuditPressureRatio(health);
  const healthLatencyMs = readHealthLatencyMs(health);

  // queuePressureRatio: estimate from snapshot summary if available
  const snapshot = isPlainRecord(bridgeState.operator.snapshot)
    ? bridgeState.operator.snapshot as Record<string, unknown>
    : undefined;
  const liveSummary = isPlainRecord(bridgeState.operator.liveSummary)
    ? bridgeState.operator.liveSummary as Record<string, unknown>
    : undefined;
  const taskCount = firstNonNegativeInteger(
    getNested(snapshot, ["summary", "taskCount"]),
    getNested(snapshot, ["taskCount"]),
    getNested(liveSummary, ["summary", "taskCount"]),
    getNested(liveSummary, ["taskCount"]),
  );
  const queuePressureRatio = taskCount && taskCount > 0
    ? Math.min(1, queueDepth / taskCount)
    : queueDepth > 0 ? 0.5 : 0;

  const messages: string[] = [];
  if (queueDepth > 0) {
    messages.push(`queue depth: ${queueDepth} pending tasks`);
  }
  if (auditPressureRatio !== undefined && auditPressureRatio >= 0.8) {
    messages.push(`audit table at ${Math.round(auditPressureRatio * 100)}% capacity — review retention/pruning`);
  }
  if (workerCounts.stale > 0) {
    messages.push(`${workerCounts.stale} stale/unknown worker(s) — operator review recommended`);
  }
  if (healthLatencyMs !== undefined && healthLatencyMs >= 1_000) {
    messages.push(`health check latency ${Math.round(healthLatencyMs)}ms — broker may be under pressure`);
  }

  const isHighPressure =
    queueDepth > 10 ||
    (auditPressureRatio !== undefined && auditPressureRatio >= 0.9) ||
    (workerCounts.total > 0 && workerCounts.stale >= workerCounts.total);
  const isElevated =
    queueDepth > 0 ||
    (auditPressureRatio !== undefined && auditPressureRatio >= 0.8) ||
    workerCounts.stale > 0 ||
    (healthLatencyMs !== undefined && healthLatencyMs >= 500);
  const status: "elevated" | "normal" = isHighPressure || isElevated ? "elevated" : "normal";

  return {
    status,
    pressure: {
      queueDepth,
      queuePressureRatio,
      ...(auditPressureRatio !== undefined ? { auditPressureRatio } : {}),
      ...(healthLatencyMs !== undefined ? { healthLatencyMs } : {}),
      staleWorkerCount: workerCounts.stale,
      totalWorkerCount: workerCounts.total,
    },
    messages: messages.slice(0, 10),
  };
}

/**
 * Project queue hygiene from operator bridge state + optional diagnostics.
 *
 * Synthesizes stale tasks, timed-out tasks, unacknowledged outbox events,
 * receipt gaps, and pending local queue depth. Provider send/message-id
 * remains non-ACK evidence; terminal ACK requires operator-visible or
 * manual-receipt confirmation.
 */
export function projectQueueHygieneOperatorStatus(
  bridgeState: A2AOperatorEventBridgeState,
  terminalReceiptGaps?: A2ABrokerTerminalReceiptGapProjection[],
): A2AQueueHygieneProjection {
  const hygieneFromSummary = readQueueHygieneFromLiveSummary(bridgeState.operator.liveSummary);
  const receiptGapCount = terminalReceiptGaps?.length
    ?? readTerminalReceiptGapCount(bridgeState);
  const unacknowledgedOutboxCount = readUnacknowledgedOutboxCount(bridgeState);
  const evidenceMissing = readGitHubEvidenceHygiene(bridgeState).evidenceMissing;

  // Combine stale signals from live summary + github evidence
  const staleTaskCount = hygieneFromSummary.stale + evidenceMissing;
  const timedOutTaskCount = hygieneFromSummary.timedOut;
  const pendingLocalQueueCount = hygieneFromSummary.pending;
  const claimedRunningCount = hygieneFromSummary.claimedRunning;

  const messages: string[] = [];
  if (staleTaskCount > 0) {
    messages.push(`${staleTaskCount} stale entries (${hygieneFromSummary.stale} tasks, ${evidenceMissing} missing GitHub evidence)`);
  }
  if (timedOutTaskCount > 0) {
    messages.push(`${timedOutTaskCount} timed-out tasks — may need cancellation or refresh`);
  }
  if (unacknowledgedOutboxCount > 0) {
    messages.push(`unacknowledged outbox: ${unacknowledgedOutboxCount} pending ACK(s)`);
  }
  if (receiptGapCount > 0) {
    messages.push(`${receiptGapCount} receipt gap(s) — terminal ACK blocked until operator-visible`);
  }
  if (pendingLocalQueueCount > 0) {
    messages.push(`${pendingLocalQueueCount} pending local queue entries`);
  }
  if (messages.length === 0) {
    messages.push("queue hygiene is clean — no stale, timed-out, unacknowledged, or gap signal");
  }

  const status =
    staleTaskCount > 5 || timedOutTaskCount > 5
      ? "blocked"
      : staleTaskCount > 0 || timedOutTaskCount > 0 || unacknowledgedOutboxCount > 0
        ? "stale"
        : "clean";

  return {
    status,
    hygiene: {
      staleTaskCount,
      timedOutTaskCount,
      unacknowledgedOutboxCount,
      receiptGapCount,
      pendingLocalQueueCount,
      claimedRunningCount,
    },
    messages: messages.slice(0, 10),
  };
}

/**
 * Build a combined operator status projection from operator bridge state,
 * health, and optional terminal receipt gaps.
 *
 * Provider send success is explicitly non-ACK evidence; terminal ACK requires
 * operator-visible current-session or manual-receipt confirmation.
 */
export function projectA2AOperatorStatus(
  bridgeState: A2AOperatorEventBridgeState,
  health?: unknown,
  terminalReceiptGaps?: A2ABrokerTerminalReceiptGapProjection[],
): A2AOperatorStatusProjection {
  return {
    mode: "operator-status-dryrun/no-live",
    brokerPressure: projectBrokerPressureOperatorStatus(bridgeState, health),
    queueHygiene: projectQueueHygieneOperatorStatus(bridgeState, terminalReceiptGaps),
    providerSendNotAckEvidence: true,
    safeOperations: {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    },
  };
}

/**
 * Derive a terminal-receipt-gap projection array from operator bridge state
 * when the raw diagnostics record does not carry explicit gap data.
 */
export function projectTerminalReceiptGapsFromBridge(
  bridgeState: A2AOperatorEventBridgeState,
): A2ABrokerTerminalReceiptGapProjection[] {
  const receipts = bridgeState.operator.terminalReceipts;
  if (!Array.isArray(receipts) || receipts.length === 0) return [];
  return receipts
    .filter((r: Record<string, unknown>) =>
      r.receiptGapStatus !== "confirmed" && r.receiptGapStatus !== undefined
    )
    .map((r: Record<string, unknown>) => ({
      taskId: String(r.taskId ?? ""),
      ...(typeof r.status === "string" && r.status ? { status: r.status } : {}),
      receiptState: r.receiptStatus === "received" ? "operator-visible" as const : "pending" as const,
      receiptStatus: (r.receiptStatus === "received" ? "received" : "pending") as "received" | "pending",
      receiptGapStatus: r.receiptGapStatus as A2ABrokerTerminalReceiptGapProjection["receiptGapStatus"],
      operatorReceiptState: (r.operatorReceiptState ?? "pending_receipt") as A2AOperatorVisibleTerminalReceiptState,
      operatorReceiptLabel: typeof r.operatorReceiptLabel === "string" ? r.operatorReceiptLabel : "⋯ pending receipt",
      terminalAckEligible: false,
      reason: typeof r.reason === "string" ? r.reason : "no receipt confirmation",
    }))
    .slice(0, 25);
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createA2ABrokerClient,
  type A2ABrokerClientOptions,
} from "../standalone-broker-client.js";
import { normalizeTerminalBriefDeliveryReceiptDecision } from "./terminal-brief-delivery-contract.js";
import {
  createA2AOperatorEventBridge,
  type A2AOperatorEventBridge,
  type A2AOperatorEventBridgeBrokerClient,
  type A2AOperatorEventBridgeState,
  type A2AOperatorNotificationAckDecision,
  type A2AOperatorTerminalOutboxDoctorDiagnostics,
  type A2AOperatorTerminalOutboxEventProjection,
} from "./operator-event-bridge.js";
import type { A2AOperatorTerminalNotificationEnvelope } from "./operator-terminal-notifier.js";

export type A2ATerminalBriefSidecarDeliveryMode = "dry-run" | "external";

export type A2ATerminalBriefSidecarConfig = {
  baseUrl: string;
  edgeSecret?: string;
  requester?: A2ABrokerClientOptions["requester"];
  cursorFile?: string;
  operatorCursor?: string;
  terminalOutboxCursor?: string;
  terminalOutboxAllowedIds?: readonly string[];
  terminalOutboxPollMs?: number;
  terminalOutboxLimit?: number;
  terminalOutboxHistoricalReplay?: "suppress" | "notify";
  terminalEventHistoricalReplay?: "suppress" | "notify";
  terminalOutboxReconcileUnackedOnStart?: boolean;
  operatorEventStreamEnabled?: boolean;
  deliveryMode?: A2ATerminalBriefSidecarDeliveryMode;
  notificationMaxTextChars?: number;
  handoffBrokerId?: string;
};

export type A2ATerminalBriefSidecarCursorSnapshot = {
  operatorCursor?: string;
  terminalOutboxCursor?: string;
  updatedAt?: string;
};

export type A2ATerminalBriefSidecarCursorStore = {
  readOperatorCursor(): string | undefined;
  writeOperatorCursor(cursor: string): void;
  readTerminalOutboxCursor(): string | undefined;
  writeTerminalOutboxCursor(cursor: string): void;
  snapshot(): A2ATerminalBriefSidecarCursorSnapshot;
};

export type A2ATerminalBriefSidecarStatus = {
  kind: "a2a.terminalBrief.sidecar.status";
  status: "configured" | "running" | "stopped";
  deliveryMode: A2ATerminalBriefSidecarDeliveryMode;
  gatewayOperatorEventsRequired: false;
  openClawGatewayEventLoopShared: false;
  cursorFile?: string;
  operatorEventStreamEnabled: boolean;
  terminalOutbox: {
    cursor?: string;
    allowedIds: string[];
    historicalReplay: "suppress" | "notify";
    reconcileUnackedOnStart: boolean;
    pollMs: number;
    limit: number;
  };
  safety: {
    providerAcceptedIsTerminalAckEvidence: false;
    historicalReplayDefault: "suppress";
    gatewayRestartRequiredForCursorChange: false;
    liveSendRequiresExternalNotifier: true;
  };
  bridge?: A2AOperatorEventBridgeState;
  dryRunNotifications: number;
};

export type A2ATerminalBriefDoctorReport = {
  kind: "a2a.terminalBrief.sidecar.doctorReport";
  recordedAt: string;
  cursorState: {
    operatorCursor?: string;
    terminalOutboxCursor?: string;
    cursorFile?: string;
    cursorSnapshotUpdatedAt?: string;
  };
  staleRows: A2AOperatorTerminalOutboxEventProjection[];
  projectionQueue: {
    poller?: A2ATerminalBriefSidecarStatus["terminalOutbox"];
    lastPoll?: {
      timestamp?: number;
      count?: number;
      pendingUnacknowledged?: number;
      backlogDrain?: boolean;
    };
  };
  duplicateSuppression: {
    doctorDiagnostics?: A2AOperatorTerminalOutboxDoctorDiagnostics;
  };
  lastOperatorVisibleAck?: {
    id: string;
    taskId?: string;
    evidence: string;
    receiptId?: string;
    acknowledgedAt: string;
    timestamp: number;
  };
  dryRunNotifications: number;
  safety: A2ATerminalBriefSidecarStatus["safety"];
};

export type A2ATerminalBriefSidecar = {
  start(): A2ATerminalBriefSidecarStatus;
  getStatus(): A2ATerminalBriefSidecarStatus;
  doctor(): A2ATerminalBriefDoctorReport;
  listDryRunNotifications(): A2AOperatorTerminalNotificationEnvelope[];
  waitForIdle(): Promise<void>;
  shutdown(): void;
};

export type A2ATerminalBriefSidecarDeps = {
  broker?: A2AOperatorEventBridgeBrokerClient;
  createClient?: typeof createA2ABrokerClient;
  cursorStore?: A2ATerminalBriefSidecarCursorStore;
  now?: () => number;
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  notifyOperator?: (
    envelope: A2AOperatorTerminalNotificationEnvelope,
  ) => void | A2AOperatorNotificationAckDecision | Promise<void | A2AOperatorNotificationAckDecision>;
};

const DEFAULT_TERMINAL_OUTBOX_POLL_MS = 15_000;
const DEFAULT_TERMINAL_OUTBOX_LIMIT = 25;

export function createMemoryTerminalBriefSidecarCursorStore(
  initial: A2ATerminalBriefSidecarCursorSnapshot = {},
): A2ATerminalBriefSidecarCursorStore {
  let snapshot = normalizeCursorSnapshot(initial);
  return {
    readOperatorCursor() {
      return snapshot.operatorCursor;
    },
    writeOperatorCursor(cursor) {
      snapshot = normalizeCursorSnapshot({
        ...snapshot,
        operatorCursor: normalizeOptionalString(cursor),
        updatedAt: new Date().toISOString(),
      });
    },
    readTerminalOutboxCursor() {
      return snapshot.terminalOutboxCursor;
    },
    writeTerminalOutboxCursor(cursor) {
      snapshot = normalizeCursorSnapshot({
        ...snapshot,
        terminalOutboxCursor: normalizeOptionalString(cursor),
        updatedAt: new Date().toISOString(),
      });
    },
    snapshot() {
      return { ...snapshot };
    },
  };
}

export function createFileTerminalBriefSidecarCursorStore(
  filePath: string,
): A2ATerminalBriefSidecarCursorStore {
  let snapshot = readCursorFile(filePath);
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const next = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(tempPath, filePath);
    snapshot = normalizeCursorSnapshot(next);
  };
  return {
    readOperatorCursor() {
      return snapshot.operatorCursor;
    },
    writeOperatorCursor(cursor) {
      snapshot = normalizeCursorSnapshot({ ...snapshot, operatorCursor: normalizeOptionalString(cursor) });
      persist();
    },
    readTerminalOutboxCursor() {
      return snapshot.terminalOutboxCursor;
    },
    writeTerminalOutboxCursor(cursor) {
      snapshot = normalizeCursorSnapshot({ ...snapshot, terminalOutboxCursor: normalizeOptionalString(cursor) });
      persist();
    },
    snapshot() {
      return { ...snapshot };
    },
  };
}

export function createA2ATerminalBriefSidecar(
  input: A2ATerminalBriefSidecarConfig,
  deps: A2ATerminalBriefSidecarDeps = {},
): A2ATerminalBriefSidecar {
  const config = normalizeA2ATerminalBriefSidecarConfig(input);
  const dryRunNotifications: A2AOperatorTerminalNotificationEnvelope[] = [];
  const cursorStore = deps.cursorStore
    ?? (config.cursorFile
      ? createFileTerminalBriefSidecarCursorStore(config.cursorFile)
      : createMemoryTerminalBriefSidecarCursorStore({
          operatorCursor: config.operatorCursor,
          terminalOutboxCursor: config.terminalOutboxCursor,
        }));
  const broker = wrapBrokerForSidecar(
    deps.broker ?? (deps.createClient ?? createA2ABrokerClient)({
      baseUrl: config.baseUrl,
      ...(config.edgeSecret ? { edgeSecret: config.edgeSecret } : {}),
      ...(config.requester ? { requester: config.requester } : {}),
      userAgent: "openclaw-a2a-terminal-brief-sidecar/0.1",
    }),
    config,
    deps.waitForRetry,
  );

  if (config.deliveryMode === "external" && !deps.notifyOperator) {
    throw new Error("Terminal Brief sidecar external delivery requires a notifyOperator dependency");
  }
  const notifyOperator = config.deliveryMode === "external"
    ? deps.notifyOperator
    : createDryRunNotificationHandler(dryRunNotifications);

  let running = false;
  let lastBridgeState: A2AOperatorEventBridgeState | undefined;
  const bridge: A2AOperatorEventBridge = createA2AOperatorEventBridge({
    broker,
    now: deps.now,
    waitForRetry: deps.waitForRetry,
    readCursor: () => cursorStore.readOperatorCursor() ?? config.operatorCursor,
    writeCursor: (cursor) => cursorStore.writeOperatorCursor(cursor),
    readTerminalOutboxCursor: () => cursorStore.readTerminalOutboxCursor() ?? config.terminalOutboxCursor,
    writeTerminalOutboxCursor: (cursor) => cursorStore.writeTerminalOutboxCursor(cursor),
    terminalOutboxCursor: config.terminalOutboxCursor,
    terminalOutboxAllowedIds: config.terminalOutboxAllowedIds,
    terminalOutboxPollMs: config.terminalOutboxPollMs,
    terminalOutboxLimit: config.terminalOutboxLimit,
    terminalOutboxHistoricalReplay: config.terminalOutboxHistoricalReplay,
    terminalEventHistoricalReplay: config.terminalEventHistoricalReplay,
    terminalOutboxReconcileUnackedOnStart: config.terminalOutboxReconcileUnackedOnStart,
    notificationMaxTextChars: config.notificationMaxTextChars,
    handoffBrokerId: config.handoffBrokerId,
    notifyOperator,
  });

  return {
    start() {
      running = true;
      lastBridgeState = bridge.getState({ cursor: cursorStore.readOperatorCursor() ?? config.operatorCursor });
      return buildStatus(config, cursorStore, dryRunNotifications, lastBridgeState, "running");
    },
    getStatus() {
      return buildStatus(config, cursorStore, dryRunNotifications, lastBridgeState, running ? "running" : "configured");
    },
    doctor() {
      const freshBridgeState = bridge.getState({ cursor: cursorStore.readOperatorCursor() ?? config.operatorCursor });
      const status = buildStatus(config, cursorStore, dryRunNotifications, freshBridgeState, running ? "running" : "configured");
      const snapshot = cursorStore.snapshot();
      const bridgeTerminalOutbox = freshBridgeState?.operator.terminalOutbox;
      const staleRows = bridgeTerminalOutbox?.pendingUnacknowledged ?? [];
      const lastAck = bridgeTerminalOutbox?.lastAck;
      return {
        kind: "a2a.terminalBrief.sidecar.doctorReport",
        recordedAt: new Date().toISOString(),
        cursorState: {
          ...(snapshot.operatorCursor ? { operatorCursor: snapshot.operatorCursor } : {}),
          ...(snapshot.terminalOutboxCursor ? { terminalOutboxCursor: snapshot.terminalOutboxCursor } : {}),
          ...(config.cursorFile ? { cursorFile: config.cursorFile } : {}),
          ...(snapshot.updatedAt ? { cursorSnapshotUpdatedAt: snapshot.updatedAt } : {}),
        },
        staleRows,
        projectionQueue: {
          poller: status.terminalOutbox,
          ...(bridgeTerminalOutbox?.lastPoll
            ? {
                lastPoll: {
                  timestamp: bridgeTerminalOutbox.lastPoll.timestamp,
                  count: bridgeTerminalOutbox.lastPoll.count,
                  pendingUnacknowledged: bridgeTerminalOutbox.lastPoll.pendingUnacknowledged,
                  backlogDrain: bridgeTerminalOutbox.lastPoll.backlogDrain,
                },
              }
            : {}),
        },
        duplicateSuppression: {
          doctorDiagnostics: bridgeTerminalOutbox?.doctorDiagnostics,
        },
        ...(lastAck
          ? {
              lastOperatorVisibleAck: {
                id: lastAck.id,
                ...(lastAck.taskId ? { taskId: lastAck.taskId } : {}),
                evidence: lastAck.evidence,
                ...(lastAck.receiptId ? { receiptId: lastAck.receiptId } : {}),
                acknowledgedAt: lastAck.acknowledgedAt,
                timestamp: lastAck.timestamp,
              },
            }
          : {}),
        dryRunNotifications: dryRunNotifications.length,
        safety: status.safety,
      };
    },
    listDryRunNotifications() {
      return dryRunNotifications.map((item) => ({ ...item }));
    },
    async waitForIdle() {
      await bridge.waitForIdle();
    },
    shutdown() {
      running = false;
      bridge.shutdown();
    },
  };
}

export function normalizeA2ATerminalBriefSidecarConfig(
  input: A2ATerminalBriefSidecarConfig,
): Required<Pick<
  A2ATerminalBriefSidecarConfig,
  | "baseUrl"
  | "terminalOutboxAllowedIds"
  | "terminalOutboxPollMs"
  | "terminalOutboxLimit"
  | "terminalOutboxHistoricalReplay"
  | "terminalEventHistoricalReplay"
  | "terminalOutboxReconcileUnackedOnStart"
  | "operatorEventStreamEnabled"
  | "deliveryMode"
>> & A2ATerminalBriefSidecarConfig {
  const baseUrl = normalizeOptionalString(input.baseUrl);
  if (!baseUrl) {
    throw new Error("Terminal Brief sidecar requires baseUrl");
  }
  return {
    ...input,
    baseUrl,
    edgeSecret: normalizeOptionalString(input.edgeSecret),
    cursorFile: normalizeOptionalString(input.cursorFile),
    operatorCursor: normalizeOptionalString(input.operatorCursor),
    terminalOutboxCursor: normalizeOptionalString(input.terminalOutboxCursor),
    terminalOutboxAllowedIds: normalizeStringArray(input.terminalOutboxAllowedIds),
    terminalOutboxPollMs: normalizePositiveInteger(input.terminalOutboxPollMs, DEFAULT_TERMINAL_OUTBOX_POLL_MS),
    terminalOutboxLimit: normalizePositiveInteger(input.terminalOutboxLimit, DEFAULT_TERMINAL_OUTBOX_LIMIT),
    terminalOutboxHistoricalReplay: input.terminalOutboxHistoricalReplay === "notify" ? "notify" : "suppress",
    terminalEventHistoricalReplay: input.terminalEventHistoricalReplay === "notify" ? "notify" : "suppress",
    terminalOutboxReconcileUnackedOnStart: input.terminalOutboxReconcileUnackedOnStart === true,
    operatorEventStreamEnabled: input.operatorEventStreamEnabled === true,
    deliveryMode: input.deliveryMode === "external" ? "external" : "dry-run",
  };
}

export function createCommandNotificationHandler(params: {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
}): (envelope: A2AOperatorTerminalNotificationEnvelope) => A2AOperatorNotificationAckDecision {
  const command = normalizeOptionalString(params.command);
  if (!command) {
    throw new Error("delivery command is required");
  }
  const args = params.args ? [...params.args] : [];
  const timeout = normalizePositiveInteger(params.timeoutMs, 30_000);
  return (envelope) => {
    const child = spawnSync(command, args, {
      input: JSON.stringify(envelope),
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
    });
    if (child.error) {
      return {
        ackTerminalEvent: false,
        reason: `delivery command failed before receipt confirmation: ${child.error.message}`,
      };
    }
    if (child.status !== 0) {
      return {
        ackTerminalEvent: false,
        reason: `delivery command exited ${child.status ?? "unknown"} before receipt confirmation`,
      };
    }
    const text = child.stdout.trim();
    if (!text) {
      return {
        ackTerminalEvent: false,
        reason: "delivery command returned no receipt decision",
      };
    }
    try {
      return normalizeCommandReceipt(JSON.parse(text));
    } catch {
      return {
        ackTerminalEvent: false,
        reason: "delivery command returned unparseable receipt decision",
      };
    }
  };
}

function wrapBrokerForSidecar(
  broker: A2AOperatorEventBridgeBrokerClient,
  config: ReturnType<typeof normalizeA2ATerminalBriefSidecarConfig>,
  waitForRetry: A2ATerminalBriefSidecarDeps["waitForRetry"],
): A2AOperatorEventBridgeBrokerClient {
  if (config.operatorEventStreamEnabled) {
    return broker;
  }
  return {
    ...broker,
    async *streamOperatorEvents(options = {}) {
      if (options.signal?.aborted) return;
      if (waitForRetry) {
        await waitForRetry(config.terminalOutboxPollMs, options.signal ?? new AbortController().signal).catch(() => undefined);
      } else {
        await waitForAbort(options.signal);
      }
    },
  };
}

function createDryRunNotificationHandler(
  dryRunNotifications: A2AOperatorTerminalNotificationEnvelope[],
): (envelope: A2AOperatorTerminalNotificationEnvelope) => A2AOperatorNotificationAckDecision {
  return (envelope) => {
    dryRunNotifications.push({ ...envelope, dryRun: true });
    return {
      ackTerminalEvent: false,
      reason: "sidecar dry-run rendered Terminal Brief only; no provider send or terminal ACK",
    };
  };
}

function buildStatus(
  config: ReturnType<typeof normalizeA2ATerminalBriefSidecarConfig>,
  cursorStore: A2ATerminalBriefSidecarCursorStore,
  dryRunNotifications: readonly A2AOperatorTerminalNotificationEnvelope[],
  bridgeState: A2AOperatorEventBridgeState | undefined,
  status: A2ATerminalBriefSidecarStatus["status"],
): A2ATerminalBriefSidecarStatus {
  const snapshot = cursorStore.snapshot();
  return {
    kind: "a2a.terminalBrief.sidecar.status",
    status,
    deliveryMode: config.deliveryMode,
    gatewayOperatorEventsRequired: false,
    openClawGatewayEventLoopShared: false,
    ...(config.cursorFile ? { cursorFile: config.cursorFile } : {}),
    operatorEventStreamEnabled: config.operatorEventStreamEnabled,
    terminalOutbox: {
      cursor: snapshot.terminalOutboxCursor ?? config.terminalOutboxCursor,
      allowedIds: [...config.terminalOutboxAllowedIds],
      historicalReplay: config.terminalOutboxHistoricalReplay,
      reconcileUnackedOnStart: config.terminalOutboxReconcileUnackedOnStart,
      pollMs: config.terminalOutboxPollMs,
      limit: config.terminalOutboxLimit,
    },
    safety: {
      providerAcceptedIsTerminalAckEvidence: false,
      historicalReplayDefault: "suppress",
      gatewayRestartRequiredForCursorChange: false,
      liveSendRequiresExternalNotifier: true,
    },
    ...(bridgeState ? { bridge: bridgeState } : {}),
    dryRunNotifications: dryRunNotifications.length,
  };
}

function normalizeCommandReceipt(value: unknown): A2AOperatorNotificationAckDecision {
  return normalizeTerminalBriefDeliveryReceiptDecision(value);
}

function readCursorFile(filePath: string): A2ATerminalBriefSidecarCursorSnapshot {
  try {
    return normalizeCursorSnapshot(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return {};
  }
}

function normalizeCursorSnapshot(value: unknown): A2ATerminalBriefSidecarCursorSnapshot {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(normalizeOptionalString(record.operatorCursor) ? { operatorCursor: normalizeOptionalString(record.operatorCursor) } : {}),
    ...(normalizeOptionalString(record.terminalOutboxCursor) ? { terminalOutboxCursor: normalizeOptionalString(record.terminalOutboxCursor) } : {}),
    ...(normalizeOptionalString(record.updatedAt) ? { updatedAt: normalizeOptionalString(record.updatedAt) } : {}),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(normalizeOptionalString).filter((item): item is string => Boolean(item))
    : [];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

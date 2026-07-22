import { sanitizeBuildToken } from "./build-metadata-sanitize.js";
import {
  DEFAULT_BROKER_RETENTION_POLICY,
  type BrokerRetentionPolicy,
} from "./core/broker.js";
import {
  DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
  DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
} from "./core/store.js";

export interface BrokerHotRuntimeLimits {
  maxNonTerminalTasks: number;
  maxTerminalTasks: number;
  maxAuditEvents: number;
  maxHeartbeatAuditEvents: number;
  maxTerminalOutboxEvents: number;
}

export interface BrokerRuntimeHotLimitOptions {
  /** Max non-terminal task rows to hydrate from SQLite hot tables. Env: `BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS`. */
  maxHotRuntimeNonTerminalTasks?: number;
  /** Max terminal task rows to hydrate from SQLite hot tables; active tasks always hydrate. Env: `BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS`. */
  maxHotRuntimeTerminalTasks?: number;
  /** Max audit rows to hydrate from SQLite hot tables. Env: BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS. */
  maxHotRuntimeAuditEvents?: number;
  /** Max heartbeat audit rows retained in SQLite hot tables. Env: BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS. */
  maxHotRuntimeHeartbeatAuditEvents?: number;
  /** Max terminal outbox rows to hydrate from SQLite hot tables. Env: `BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS`. */
  maxHotRuntimeTerminalOutboxEvents?: number;
}

export const DEFAULT_BROKER_HOT_RUNTIME_LIMITS: BrokerHotRuntimeLimits = {
  maxNonTerminalTasks: DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
  maxTerminalTasks: DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
  maxAuditEvents: DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
  maxHeartbeatAuditEvents: DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
  maxTerminalOutboxEvents: DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
};

export function resolveHotRuntimeLimits(
  options: BrokerRuntimeHotLimitOptions,
): BrokerHotRuntimeLimits {
  return {
    maxNonTerminalTasks: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeNonTerminalTasks,
        process.env.BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxNonTerminalTasks,
      ),
    ),
    maxTerminalTasks: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeTerminalTasks,
        process.env.BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalTasks,
      ),
    ),
    maxAuditEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeAuditEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents,
      ),
    ),
    maxHeartbeatAuditEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeHeartbeatAuditEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
        Math.min(
          DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents,
          DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxHeartbeatAuditEvents,
        ),
      ),
    ),
    maxTerminalOutboxEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeTerminalOutboxEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalOutboxEvents,
      ),
    ),
  };
}

export function resolveBrokerRetentionPolicy(
  overrides?: Partial<BrokerRetentionPolicy>,
  fallbacks?: {
    /**
     * Deployment-derived default for the terminal-task byte budget (#1579).
     * The server passes half the resolved snapshot byte cap so retention and
     * STATE_FILE_MAX_BYTES stay consistent whatever the operator configures;
     * explicit overrides and BROKER_MAX_TERMINAL_TASK_BYTES still win.
     */
    maxTerminalTaskBytes?: number;
  },
): BrokerRetentionPolicy {
  const maxAuditEvents = resolvePolicyNumber(
    overrides?.maxAuditEvents,
    process.env.BROKER_MAX_AUDIT_EVENTS,
    DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
  );
  return {
    terminalRetentionMs: resolvePolicyNumber(
      overrides?.terminalRetentionMs,
      process.env.BROKER_TERMINAL_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
    ),
    maxTerminalExchanges: resolvePolicyNumber(
      overrides?.maxTerminalExchanges,
      process.env.BROKER_MAX_TERMINAL_EXCHANGES,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalExchanges,
    ),
    maxTerminalTasks: resolvePolicyNumber(
      overrides?.maxTerminalTasks,
      process.env.BROKER_MAX_TERMINAL_TASKS,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
    ),
    maxTerminalTaskBytes: resolvePolicyNumber(
      overrides?.maxTerminalTaskBytes,
      process.env.BROKER_MAX_TERMINAL_TASK_BYTES,
      fallbacks?.maxTerminalTaskBytes ?? DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTaskBytes,
    ),
    maxTerminalProposals: resolvePolicyNumber(
      overrides?.maxTerminalProposals,
      process.env.BROKER_MAX_TERMINAL_PROPOSALS,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalProposals,
    ),
    inactiveWorkerRetentionMs: resolvePolicyNumber(
      overrides?.inactiveWorkerRetentionMs,
      process.env.BROKER_INACTIVE_WORKER_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
    ),
    maxInactiveWorkers: resolvePolicyNumber(
      overrides?.maxInactiveWorkers,
      process.env.BROKER_MAX_INACTIVE_WORKERS,
      DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
    ),
    auditRetentionMs: resolvePolicyNumber(
      overrides?.auditRetentionMs,
      process.env.BROKER_AUDIT_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
    ),
    maxAuditEvents,
    maxHeartbeatAuditEvents: resolvePolicyNumber(
      overrides?.maxHeartbeatAuditEvents,
      process.env.BROKER_MAX_HEARTBEAT_AUDIT_EVENTS,
      Math.min(maxAuditEvents, DEFAULT_BROKER_RETENTION_POLICY.maxHeartbeatAuditEvents),
    ),
    heartbeatAuditSampleIntervalMs: resolvePolicyNumber(
      overrides?.heartbeatAuditSampleIntervalMs,
      process.env.BROKER_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS,
      DEFAULT_BROKER_RETENTION_POLICY.heartbeatAuditSampleIntervalMs,
    ),
  };
}

export function resolveStringOption(
  explicit: string | undefined,
  fromEnv: string | undefined,
  fallback?: string,
): string | undefined {
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

export function resolveIntegerOption(
  explicit: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.trunc(explicit);
  }
  if (fromEnv !== undefined) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

export function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

export function resolveBrokerId(explicit: string | undefined, serviceName: string): string {
  return sanitizeBuildToken(explicit ?? process.env.A2A_BROKER_ID ?? process.env.BROKER_ID ?? serviceName, {
    fallback: serviceName,
    unsafeFallback: "redacted",
  }) ?? serviceName;
}

function resolvePolicyNumber(
  explicit: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.trunc(explicit));
  }
  const parsed = Number(fromEnv);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.trunc(parsed));
  }
  return fallback;
}

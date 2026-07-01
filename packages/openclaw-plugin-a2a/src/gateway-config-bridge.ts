/**
 * Gateway config bridge — safe operatorEvents/notification config injection
 * for the a2a-broker-adapter plugin.
 *
 * Issue:  jinwon-int/plugin-a2a#269
 * Parent: a2a-plane#241 (internal tracker, private)
 * Run:    terminal-brief-activation-20260511T080211Z
 *
 * Provides a safe config bridge that injects operatorEvents.enabled +
 * notification.enabled settings into the Gateway's a2a-broker-adapter plugin
 * config. Always follows the backup → apply → verify → rollback-on-fail
 * pattern. Plugin-level config only — never touches core Gateway config.
 *
 * Safety gates:
 *  - Plugin-level config only (no core Gateway config change)
 *  - Never sends live provider messages
 *  - Always backup → apply → verify → rollback-on-fail
 *  - Rollback is always safe (restores the exact pre-apply snapshot)
 *  - No side effects during diff / validation
 */
import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "../plugin-id.js";
import type {
  A2ABrokerAdapterPluginRuntimeConfig,
  A2ABrokerAdapterEntryConfig,
} from "../config.js";
import { resolveA2ABrokerAdapterPluginConfig } from "../config.js";

// ── Public types ────────────────────────────────────────────────────

/** Snapshot of the plugin entry config before bridge application. */
export type A2AGatewayConfigSnapshot = {
  /** The plugin entry config as it was before application, or undefined. */
  entry: A2ABrokerAdapterEntryConfig | undefined;
  /** The plugin entry enabled flag as it was before application, or undefined. */
  enabled: boolean | undefined;
  /** When the snapshot was taken (epoch ms). */
  takenAt: number;
};

/** Settings the bridge can inject for operatorEvents + notification. */
export type A2AGatewayConfigBridgeSettings = {
  /** Enable the operator event bridge. */
  operatorEventsEnabled?: boolean;
  /** Enable operator notification delivery. */
  notificationEnabled?: boolean;
  /** Destination channel for operator terminal notifications. */
  notificationChannel?: string;
  /** Destination target for operator terminal notifications. */
  notificationTo?: string;
  /** Optional channel account id. */
  notificationAccountId?: string;
  /** Optional thread/topic id. */
  notificationThreadId?: string | number;
  /** Optional terminal-outbox cursor used for bounded live canaries. */
  terminalOutboxCursor?: string;
  /** Optional terminal-outbox id/prefix allowlist used for bounded live canaries. */
  terminalOutboxAllowedIds?: readonly string[];
  /** Whether startup should reconcile historical unacknowledged outbox rows. */
  terminalOutboxReconcileUnackedOnStart?: boolean;
};

/** Application result for the config bridge. */
export type A2AGatewayConfigBridgeApplication = {
  /** Whether application succeeded (verified). */
  ok: true;

  /** The updated config — safe to use. */
  config: A2ABrokerAdapterPluginRuntimeConfig;

  /** Backup snapshot for rollback. */
  backup: A2AGatewayConfigSnapshot;

  /** Human-readable diff lines. */
  diff: string[];

  /** Resolved plugin config after application. */
  resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>;
};

/** Failure result for the config bridge. */
export type A2AGatewayConfigBridgeFailure = {
  /** Whether application succeeded. */
  ok: false;

  /** Why it failed. */
  reason: string;

  /** The rolled-back config (identical to input). */
  config: A2ABrokerAdapterPluginRuntimeConfig;

  /** What was attempted. */
  attempted: A2AGatewayConfigBridgeSettings;

  /** Validation check failures. */
  failures: string[];
};

/** Union result of the config bridge safe application. */
export type A2AGatewayConfigBridgeResult =
  | A2AGatewayConfigBridgeApplication
  | A2AGatewayConfigBridgeFailure;

/** A single validation check. */
export type A2AGatewayConfigBridgeCheck = {
  code: string;
  ok: boolean;
  detail: string;
};

const ALLOWED_OPERATOR_EVENTS_CONFIG_KEYS = new Set([
  "enabled",
  "notification",
  "terminalOutboxCursor",
  "terminalOutboxAllowedIds",
  "terminalOutboxReconcileUnackedOnStart",
  "crossBrokers",
  "crossBrokerTerminalRelay",
]);

const ALLOWED_OPERATOR_EVENTS_NOTIFICATION_CONFIG_KEYS = new Set([
  "enabled",
  "channel",
  "to",
  "chatId",
  "accountId",
  "threadId",
  "allowUnconfirmedProviderSend",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a deep-copy backup snapshot of the a2a-broker-adapter plugin entry.
 *
 * This snapshot can be restored later with restoreGatewayConfigFromBackup().
 *
 * @param config  The current Gateway-level plugin config.
 * @param now     Optional clock override (epoch ms).
 * @returns       A snapshot of the plugin entry's state.
 */
export function createGatewayConfigBackup(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  now: () => number = Date.now,
): A2AGatewayConfigSnapshot {
  const entry = config?.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
  return {
    entry: entry ? deepClonePluginEntryConfig(entry.config) : undefined,
    enabled: entry?.enabled,
    takenAt: now(),
  };
}

/**
 * Restore the plugin entry config from a backup snapshot.
 *
 * Mutates the input config in place for caller convenience, but also returns
 * it. Always safe — restores the exact pre-snapshot state.
 *
 * @param config   The config to restore into (mutated in place).
 * @param snapshot The backup snapshot to restore from.
 * @returns        The restored config (same reference as input).
 */
export function restoreGatewayConfigFromBackup(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  snapshot: A2AGatewayConfigSnapshot,
): A2ABrokerAdapterPluginRuntimeConfig {
  const plugins = config.plugins ?? {};
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const current = entries[A2A_BROKER_ADAPTER_PLUGIN_ID] as Record<string, unknown> | undefined;

  if (snapshot.entry === undefined && snapshot.enabled === undefined) {
    // Plugin entry was absent — remove it
    delete entries[A2A_BROKER_ADAPTER_PLUGIN_ID];
  } else {
    const entry: Record<string, unknown> = current ?? {};
    if (snapshot.entry !== undefined) {
      entry.config = snapshot.entry;
    } else {
      delete entry.config;
    }
    if (snapshot.enabled !== undefined) {
      entry.enabled = snapshot.enabled;
    } else {
      delete entry.enabled;
    }
    entries[A2A_BROKER_ADAPTER_PLUGIN_ID] = entry;
  }

  return config;
}

/**
 * Apply operatorEvents/notification settings to the a2a-broker-adapter plugin
 * config. This is the direct-apply path (no backup/rollback — use applySafe for
 * that).
 *
 * Mutates the input config in place.
 *
 * @param config    The Gateway-level plugin config (mutated in place).
 * @param settings  The bridge settings to inject.
 * @returns         The mutated config (same reference as input).
 */
export function applyGatewayConfigBridge(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  settings: A2AGatewayConfigBridgeSettings,
): A2ABrokerAdapterPluginRuntimeConfig {
  const plugins = config.plugins ?? {};
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;

  const entry = (entries[A2A_BROKER_ADAPTER_PLUGIN_ID] ?? {}) as Record<string, unknown>;
  const pluginCfg = (entry.config ?? {}) as Record<string, unknown>;

  // Ensure operatorEvents block exists
  const opEvents = (pluginCfg.operatorEvents ?? {}) as Record<string, unknown>;

  // Apply operatorEvents.enabled
  if (settings.operatorEventsEnabled !== undefined) {
    opEvents.enabled = settings.operatorEventsEnabled;
  }

  // Apply notification block
  if (
    settings.notificationEnabled !== undefined ||
    settings.notificationChannel !== undefined ||
    settings.notificationTo !== undefined ||
    settings.notificationAccountId !== undefined ||
    settings.notificationThreadId !== undefined
  ) {
    const notification = (opEvents.notification ?? {}) as Record<string, unknown>;

    if (settings.notificationEnabled !== undefined) {
      notification.enabled = settings.notificationEnabled;
    }
    if (settings.notificationChannel !== undefined) {
      notification.channel = settings.notificationChannel;
    }
    if (settings.notificationTo !== undefined) {
      notification.to = settings.notificationTo;
    }
    if (settings.notificationAccountId !== undefined) {
      notification.accountId = settings.notificationAccountId;
    }
    if (settings.notificationThreadId !== undefined) {
      notification.threadId = settings.notificationThreadId;
    }

    opEvents.notification = notification;
  }

  if (settings.terminalOutboxCursor !== undefined) {
    opEvents.terminalOutboxCursor = settings.terminalOutboxCursor;
  }
  if (settings.terminalOutboxAllowedIds !== undefined) {
    opEvents.terminalOutboxAllowedIds = [...settings.terminalOutboxAllowedIds];
  }
  if (settings.terminalOutboxReconcileUnackedOnStart !== undefined) {
    opEvents.terminalOutboxReconcileUnackedOnStart = settings.terminalOutboxReconcileUnackedOnStart;
  }

  pluginCfg.operatorEvents = opEvents;
  entry.config = pluginCfg;

  // Ensure the plugin entry is enabled
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }

  entries[A2A_BROKER_ADAPTER_PLUGIN_ID] = entry;
  config.plugins = {
    ...plugins,
    entries: entries as Record<string, unknown>,
  } as A2ABrokerAdapterPluginRuntimeConfig["plugins"];

  return config;
}

/**
 * Produce a human-readable diff between the pre-apply backup and the
 * post-apply config. Each line describes one meaningful change.
 *
 * @param before Backup snapshot taken before apply.
 * @param after  Config after apply.
 * @returns      Human-readable diff lines (empty if no changes).
 */
export function diffGatewayConfigs(
  before: A2AGatewayConfigSnapshot,
  after: A2ABrokerAdapterPluginRuntimeConfig,
): string[] {
  const diff: string[] = [];
  const beforeCfg = before.entry ?? {};
  const afterRaw = after?.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
  const afterCfg = (afterRaw?.config ?? {}) as Record<string, unknown>;

  // enabled flag
  const wasEnabled = before.enabled;
  const isEnabled = afterRaw?.enabled;
  if (wasEnabled !== isEnabled) {
    diff.push(`plugin.enabled: ${wasEnabled ?? "<absent>"} → ${isEnabled ?? "<absent>"}`);
  }

  // operatorEvents.enabled
  const beforeOpEvents = (beforeCfg as Record<string, unknown>).operatorEvents as
    | Record<string, unknown>
    | undefined;
  const afterOpEvents = afterCfg.operatorEvents as Record<string, unknown> | undefined;
  const beforeOpEnabled = beforeOpEvents?.enabled;
  const afterOpEnabled = afterOpEvents?.enabled;
  if (beforeOpEnabled !== afterOpEnabled) {
    diff.push(
      `operatorEvents.enabled: ${beforeOpEnabled ?? "<absent>"} → ${afterOpEnabled ?? "<absent>"}`,
    );
  }

  // notification block
  const beforeNotif = beforeOpEvents?.notification as Record<string, unknown> | undefined;
  const afterNotif = afterOpEvents?.notification as Record<string, unknown> | undefined;

  const notifKeys = ["enabled", "channel", "to", "accountId", "threadId"] as const;
  for (const key of notifKeys) {
    const bv = beforeNotif?.[key];
    const av = afterNotif?.[key];
    if (bv !== av) {
      diff.push(
        `operatorEvents.notification.${key}: ${JSON.stringify(bv ?? "<absent>")} → ${JSON.stringify(av ?? "<absent>")}`,
      );
    }
  }

  const opEventKeys = ["terminalOutboxCursor", "terminalOutboxAllowedIds", "terminalOutboxReconcileUnackedOnStart"] as const;
  for (const key of opEventKeys) {
    const bv = beforeOpEvents?.[key];
    const av = afterOpEvents?.[key];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      diff.push(
        `operatorEvents.${key}: ${JSON.stringify(bv ?? "<absent>")} → ${JSON.stringify(av ?? "<absent>")}`,
      );
    }
  }

  return diff;
}

/**
 * Validate that the post-apply config is well-formed and safe for the
 * notifier to consume.
 *
 * Returns a list of checks — all checks must pass (ok=true) for the config
 * to be considered valid.
 *
 * @param config   Config after bridge application.
 * @param settings The settings that were applied.
 * @returns        Validation checks.
 */
export function validateConfigBridgeApplication(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  settings: A2AGatewayConfigBridgeSettings,
): A2AGatewayConfigBridgeCheck[] {
  const checks: A2AGatewayConfigBridgeCheck[] = [];

  // 1. Plugin entry must exist
  const entry = config?.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
  if (!entry) {
    checks.push({
      code: "plugin_entry_missing",
      ok: false,
      detail: "a2a-broker-adapter plugin entry is missing from plugins.entries",
    });
    return checks; // can't inspect further
  }
  checks.push({
    code: "plugin_entry_present",
    ok: true,
    detail: "a2a-broker-adapter plugin entry exists in plugins.entries",
  });

  // 2. Plugin must be enabled
  if (entry.enabled !== true) {
    checks.push({
      code: "plugin_enabled",
      ok: false,
      detail: `a2a-broker-adapter plugin entry is not explicitly enabled (enabled=${entry.enabled})`,
    });
  } else {
    checks.push({
      code: "plugin_enabled",
      ok: true,
      detail: "a2a-broker-adapter plugin entry is explicitly enabled",
    });
  }

  // 3. operatorEvents must exist and be an object
  const opEvents = (entry.config as Record<string, unknown> | undefined)
    ?.operatorEvents;
  const hasOpEvents =
    opEvents !== undefined &&
    opEvents !== null &&
    typeof opEvents === "object" &&
    !Array.isArray(opEvents);
  checks.push({
    code: "operator_events_block_exists",
    ok: hasOpEvents,
    detail: hasOpEvents
      ? "operatorEvents config block exists"
      : "operatorEvents config block is missing or malformed",
  });

  if (!hasOpEvents) {
    return checks;
  }

  const oe = opEvents as Record<string, unknown>;

  const shapeChecks = validateOperatorEventsLiveConfigShape(oe);
  checks.push(...shapeChecks);

  // 4. operatorEvents.enabled must match requested
  if (settings.operatorEventsEnabled !== undefined) {
    const actual = oe.enabled;
    const match = actual === settings.operatorEventsEnabled;
    checks.push({
      code: "operator_events_enabled_match",
      ok: match,
      detail: match
        ? `operatorEvents.enabled=${actual} matches requested ${settings.operatorEventsEnabled}`
        : `operatorEvents.enabled=${actual} does not match requested ${settings.operatorEventsEnabled}`,
    });
  } else {
    checks.push({
      code: "operator_events_enabled_match",
      ok: true,
      detail: "operatorEvents.enabled was not requested — skipped",
    });
  }

  // 5. notification block validation
  const notification = oe.notification as Record<string, unknown> | undefined;

  if (settings.notificationEnabled === true) {
    if (!notification || typeof notification !== "object") {
      checks.push({
        code: "notification_block_exists",
        ok: false,
        detail: "notification.enabled=true was requested but notification block is missing",
      });
      return checks;
    }

    checks.push({
      code: "notification_enabled",
      ok: notification.enabled === true,
      detail:
        notification.enabled === true
          ? "operatorEvents.notification.enabled=true"
          : `operatorEvents.notification.enabled=${notification.enabled} — expected true`,
    });

    if (settings.notificationChannel !== undefined) {
      checks.push({
        code: "notification_channel",
        ok: notification.channel === settings.notificationChannel,
        detail:
          notification.channel === settings.notificationChannel
            ? `operatorEvents.notification.channel=${settings.notificationChannel}`
            : `operatorEvents.notification.channel=${notification.channel} — expected ${settings.notificationChannel}`,
      });
    }

    if (settings.notificationTo !== undefined) {
      checks.push({
        code: "notification_to",
        ok: notification.to === settings.notificationTo,
        detail:
          notification.to === settings.notificationTo
            ? `operatorEvents.notification.to=${settings.notificationTo}`
            : `operatorEvents.notification.to=${notification.to} — expected ${settings.notificationTo}`,
      });
    }

    if (settings.terminalOutboxCursor !== undefined) {
      checks.push({
        code: "terminal_outbox_cursor",
        ok: oe.terminalOutboxCursor === settings.terminalOutboxCursor,
        detail:
          oe.terminalOutboxCursor === settings.terminalOutboxCursor
            ? "operatorEvents.terminalOutboxCursor matches requested cursor"
            : `operatorEvents.terminalOutboxCursor=${oe.terminalOutboxCursor} — expected ${settings.terminalOutboxCursor}`,
      });
    }

    if (settings.terminalOutboxAllowedIds !== undefined) {
      const actual = Array.isArray(oe.terminalOutboxAllowedIds) ? oe.terminalOutboxAllowedIds : [];
      const expected = [...settings.terminalOutboxAllowedIds];
      const matches =
        actual.length === expected.length &&
        actual.every((value, index) => value === expected[index]);
      checks.push({
        code: "terminal_outbox_allowed_ids",
        ok: matches,
        detail: matches
          ? "operatorEvents.terminalOutboxAllowedIds matches requested allowlist"
          : `operatorEvents.terminalOutboxAllowedIds=${JSON.stringify(actual)} — expected ${JSON.stringify(expected)}`,
      });
    }

    if (settings.terminalOutboxReconcileUnackedOnStart !== undefined) {
      checks.push({
        code: "terminal_outbox_reconcile_unacked_on_start",
        ok: oe.terminalOutboxReconcileUnackedOnStart === settings.terminalOutboxReconcileUnackedOnStart,
        detail:
          oe.terminalOutboxReconcileUnackedOnStart === settings.terminalOutboxReconcileUnackedOnStart
            ? `operatorEvents.terminalOutboxReconcileUnackedOnStart=${settings.terminalOutboxReconcileUnackedOnStart}`
            : `operatorEvents.terminalOutboxReconcileUnackedOnStart=${oe.terminalOutboxReconcileUnackedOnStart} — expected ${settings.terminalOutboxReconcileUnackedOnStart}`,
      });
    }

    // Resolved config must show operatorEvents enabled
    try {
      const resolved = resolveA2ABrokerAdapterPluginConfig(config);
      checks.push({
        code: "resolved_operator_events_enabled",
        ok: resolved.operatorEventsEnabled === true,
        detail: resolved.operatorEventsEnabled
          ? "resolved config confirms operatorEventsEnabled=true"
          : "resolved config shows operatorEventsEnabled=false",
      });
    } catch (err) {
      checks.push({
        code: "config_resolve_failed",
        ok: false,
        detail: `resolveA2ABrokerAdapterPluginConfig threw: ${String(err)}`,
      });
    }
  } else if (settings.notificationEnabled === false) {
    checks.push({
      code: "notification_enabled",
      ok: !notification || notification.enabled !== true,
      detail: "operatorEvents.notification.enabled is not true (as expected)",
    });
  } else {
    checks.push({
      code: "notification_block_exists",
      ok: true,
      detail: "notification settings not requested — skipped notification validation",
    });
  }

  return checks;
}

/**
 * Test-only severity assessment on config drift: returns true when the
 * committed plugin operator events config is internally consistent enough
 * for a no-live preflight to pass.  This is deliberately **not** part of
 * the safe‑apply guard — it is sampled by canary tests only.
 */
export function isOperatorEventsConfigInternallyConsistent(
  cfg: A2ABrokerAdapterPluginRuntimeConfig | undefined | null,
): boolean {
  if (!cfg) return false;
  try {
    const resolved = resolveA2ABrokerAdapterPluginConfig(cfg);
    if (!resolved.enabled || !resolved.operatorEventsEnabled) return false;
  } catch {
    return false;
  }

  const entry = cfg?.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID] as Record<string, unknown> | undefined;
  const pluginCfg = (entry?.config ?? {}) as Record<string, unknown>;
  const opEvents = (pluginCfg.operatorEvents ?? {}) as Record<string, unknown>;
  if (validateOperatorEventsLiveConfigShape(opEvents).some((check) => !check.ok)) {
    return false;
  }
  const notification = opEvents.notification as Record<string, unknown> | undefined;

  // If notification is explicitly enabled, channel and to must be present
  if (notification?.enabled === true) {
    if (typeof notification.channel !== "string" || !notification.channel.trim()) {
      return false;
    }
    if (typeof notification.to !== "string" || !notification.to.trim()) {
      return false;
    }
  }

  return true;
}

// ── Safe apply (backup → apply → verify → rollback-on-fail) ──────────

/**
 * Safely apply operatorEvents/notification settings to the a2a-broker-adapter
 * plugin config with the full backup → apply → verify → rollback-on-fail
 * pattern.
 *
 * 1. Takes a backup snapshot of the current plugin entry.
 * 2. Applies the requested settings.
 * 3. Validates the result with validateConfigBridgeApplication().
 * 4. On failure: restores from backup and returns a failure result.
 * 5. On success: returns the updated config with the backup and diff.
 *
 * This is the primary API for Gateway config changes. It is safe to call
 * multiple times — each call produces a fresh backup.
 *
 * @param config    The Gateway-level plugin config (mutated in place on
 *                  success, restored on failure).
 * @param settings  The bridge settings to inject.
 * @param now       Optional clock override for backup timestamp.
 * @returns         Application success or failure.
 */
export function applyGatewayConfigBridgeSafe(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  settings: A2AGatewayConfigBridgeSettings,
  now: () => number = Date.now,
): A2AGatewayConfigBridgeResult {
  // 1. Backup
  const backup = createGatewayConfigBackup(config, now);

  // 2. Apply
  applyGatewayConfigBridge(config, settings);

  // 3. Verify
  const checks = validateConfigBridgeApplication(config, settings);
  const failures = checks.filter((c) => !c.ok);

  if (failures.length > 0) {
    // 4. Rollback on failure
    restoreGatewayConfigFromBackup(config, backup);

    return {
      ok: false,
      reason: `Config bridge validation failed: ${failures.map((f) => `[${f.code}] ${f.detail}`).join("; ")}`,
      config,
      attempted: settings,
      failures: failures.map((f) => f.detail),
    };
  }

  // 5. Success — produce diff
  const diff = diffGatewayConfigs(backup, config);
  const resolved = resolveA2ABrokerAdapterPluginConfig(config);

  return {
    ok: true,
    config,
    backup,
    diff,
    resolved,
  };
}

// ── Config template builders ────────────────────────────────────────

/**
 * Build the minimal operatorEvents + notification config template for
 * canary terminal notification.
 *
 * Returns the exact settings needed for the Gateway config bridge:
 *  - operatorEvents.enabled = true
 *  - notification.enabled = true
 *  - notification.channel = channel
 *  - notification.to = to
 *
 * @param channel  Notification channel (e.g. "telegram").
 * @param to       Notification target (e.g. "telegram:<operator-chat-id>").
 * @returns        Bridge settings ready for applyGatewayConfigBridgeSafe().
 */
export function buildOperatorNotificationConfigTemplate(
  channel: string,
  to: string,
): A2AGatewayConfigBridgeSettings {
  return {
    operatorEventsEnabled: true,
    notificationEnabled: true,
    notificationChannel: channel,
    notificationTo: to,
  };
}

/**
 * Build a disabled notification template — sets operatorEvents.enabled=true
 * but keeps notification.enabled=false. Useful as a staging step before
 * enabling live notification delivery.
 *
 * @returns Bridge settings with notification explicitly disabled.
 */
export function buildOperatorEventsOnlyTemplate(): A2AGatewayConfigBridgeSettings {
  return {
    operatorEventsEnabled: true,
    notificationEnabled: false,
  };
}

/**
 * Build schema-valid settings for a bounded Terminal Brief live canary.
 *
 * Runtime-only knobs such as terminalOutboxLimit and
 * terminalOutboxHistoricalReplay intentionally do not exist in this template:
 * the plugin manifest rejects them in live Gateway config.
 */
export function buildTerminalOutboxLiveCanaryConfigTemplate(params: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  cursor: string;
  allowedIds: readonly string[];
  reconcileUnackedOnStart?: boolean;
}): A2AGatewayConfigBridgeSettings {
  return {
    operatorEventsEnabled: true,
    notificationEnabled: true,
    notificationChannel: params.channel,
    notificationTo: params.to,
    ...(params.accountId !== undefined ? { notificationAccountId: params.accountId } : {}),
    ...(params.threadId !== undefined ? { notificationThreadId: params.threadId } : {}),
    terminalOutboxCursor: params.cursor,
    terminalOutboxAllowedIds: [...params.allowedIds],
    terminalOutboxReconcileUnackedOnStart: params.reconcileUnackedOnStart ?? false,
  };
}

export function validateOperatorEventsLiveConfigShape(
  operatorEvents: Record<string, unknown>,
): A2AGatewayConfigBridgeCheck[] {
  const checks: A2AGatewayConfigBridgeCheck[] = [];
  const unknownKeys = Object.keys(operatorEvents).filter(
    (key) => !ALLOWED_OPERATOR_EVENTS_CONFIG_KEYS.has(key),
  );
  checks.push({
    code: "operator_events_schema_keys",
    ok: unknownKeys.length === 0,
    detail: unknownKeys.length === 0
      ? "operatorEvents contains only plugin-schema-supported live config keys"
      : `operatorEvents contains unsupported live config key(s): ${unknownKeys.join(", ")}`,
  });

  const notification = operatorEvents.notification;
  if (notification !== undefined) {
    const isRecord =
      notification !== null &&
      typeof notification === "object" &&
      !Array.isArray(notification);
    if (!isRecord) {
      checks.push({
        code: "operator_events_notification_schema_keys",
        ok: false,
        detail: "operatorEvents.notification must be an object when present",
      });
    } else {
      const unknownNotificationKeys = Object.keys(notification as Record<string, unknown>).filter(
        (key) => !ALLOWED_OPERATOR_EVENTS_NOTIFICATION_CONFIG_KEYS.has(key),
      );
      checks.push({
        code: "operator_events_notification_schema_keys",
        ok: unknownNotificationKeys.length === 0,
        detail: unknownNotificationKeys.length === 0
          ? "operatorEvents.notification contains only plugin-schema-supported live config keys"
          : `operatorEvents.notification contains unsupported live config key(s): ${unknownNotificationKeys.join(", ")}`,
      });
    }
  }

  return checks;
}

// ── Internal helpers ─────────────────────────────────────────────────

type DeepCloneable =
  | string
  | number
  | boolean
  | null
  | undefined
  | DeepCloneable[]
  | { [key: string]: DeepCloneable };

function deepClonePluginEntryConfig(
  value: unknown,
): A2ABrokerAdapterEntryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as A2ABrokerAdapterEntryConfig;
}

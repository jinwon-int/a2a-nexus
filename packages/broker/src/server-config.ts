// Broker server config/bootstrap helpers extracted from server.ts: the default
// state-store factory (JSON-file or SQLite backend), PUBLIC_BASE_URL validation,
// and the firstNonEmpty value picker. createDefaultStateStore constructs the
// store classes; the rest are pure.
import { JsonFileBrokerStateStore, SqliteBrokerStateStore } from "./core/store.js";
import type { BrokerStateStore, SqliteBrokerLoadSource } from "./core/store.js";
import type { BrokerHotRuntimeLimits } from "./broker-runtime-config.js";

export function createDefaultStateStore(params: {
  backend: "json-file" | "sqlite";
  stateFile: string;
  sqliteFile?: string;
  sqliteLoadSource: SqliteBrokerLoadSource;
  maxSnapshotBytes: number;
  hotRuntimeLimits?: BrokerHotRuntimeLimits;
}): BrokerStateStore {
  if (params.backend === "sqlite") {
    return new SqliteBrokerStateStore(params.sqliteFile ?? `${params.stateFile}.sqlite`, {
      importJsonFile: params.stateFile,
      loadSource: params.sqliteLoadSource,
      maxBytes: params.maxSnapshotBytes,
      maxHotRuntimeNonTerminalTasks: params.hotRuntimeLimits?.maxNonTerminalTasks,
      maxHotRuntimeTerminalTasks: params.hotRuntimeLimits?.maxTerminalTasks,
      maxHotRuntimeAuditEvents: params.hotRuntimeLimits?.maxAuditEvents,
      maxHotRuntimeHeartbeatAuditEvents: params.hotRuntimeLimits?.maxHeartbeatAuditEvents,
      maxHotRuntimeTerminalOutboxEvents: params.hotRuntimeLimits?.maxTerminalOutboxEvents,
    });
  }
  return new JsonFileBrokerStateStore(params.stateFile, { maxBytes: params.maxSnapshotBytes });
}

export function resolvePublicBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      "PUBLIC_BASE_URL is required. Set a real public base URL instead of relying on the masked placeholder.",
    );
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.includes("<masked-host>")) {
    throw new Error(
      "PUBLIC_BASE_URL must not use the placeholder http://<masked-host>:8787. Set the real public base URL before starting the broker.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be a valid absolute URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_BASE_URL must use http or https: ${trimmed}`);
  }

  return parsed.toString();
}

export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

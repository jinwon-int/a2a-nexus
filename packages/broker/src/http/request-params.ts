// Pure HTTP query-string and JSON-body parameter parsers used by the broker
// server routes. Extracted from server.ts to keep request-shape parsing in one
// focused module, separate from server wiring and lifecycle state.
//
// These functions hold no module state: they validate and normalize raw URL or
// body input and throw BrokerError("bad_request", ...) on malformed values.
import { BrokerError } from "../core/broker.js";
import type { BrokerCleanupPlanOptions } from "../core/broker-cleanup.js";

export function numberQueryParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative number`);
  }
  return parsed;
}

export function boundedLimitQueryParam(
  url: URL,
  name: string,
  max: number,
  defaultValue?: number,
): number | undefined {
  const parsed = numberQueryParam(url, name);
  if (parsed === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(parsed)) {
    throw new BrokerError("bad_request", `${name} must be an integer`);
  }
  return Math.min(parsed, max);
}

export function booleanQueryParam(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new BrokerError("bad_request", `${name} must be a boolean`);
}

export function cleanupPlanOptionsFromUrl(url: URL): BrokerCleanupPlanOptions {
  return {
    nowMs: numberQueryParam(url, "now_ms"),
    taskRetentionMs: numberQueryParam(url, "task_retention_ms"),
    maxTerminalTasks: numberQueryParam(url, "max_terminal_tasks"),
    auditRetentionMs: numberQueryParam(url, "audit_retention_ms"),
    maxAuditEvents: numberQueryParam(url, "max_audit_events"),
    workerRetentionMs: numberQueryParam(url, "worker_retention_ms"),
    maxInactiveWorkers: numberQueryParam(url, "max_inactive_workers"),
    terminalOutboxRetentionMs: numberQueryParam(url, "terminal_outbox_retention_ms"),
    maxAcknowledgedTerminalOutboxEvents: numberQueryParam(url, "max_acknowledged_terminal_outbox_events"),
    protectedTaskIds: stringListQueryParam(url, "protected_task_id"),
    protectedWorkerIds: stringListQueryParam(url, "protected_worker_id"),
  };
}

export function cleanupPlanOptionsFromBody(body: Record<string, unknown> | null | undefined): BrokerCleanupPlanOptions {
  return {
    nowMs: nonNegativeNumberBodyField(body, "nowMs"),
    taskRetentionMs: nonNegativeNumberBodyField(body, "taskRetentionMs"),
    maxTerminalTasks: nonNegativeNumberBodyField(body, "maxTerminalTasks"),
    auditRetentionMs: nonNegativeNumberBodyField(body, "auditRetentionMs"),
    maxAuditEvents: nonNegativeNumberBodyField(body, "maxAuditEvents"),
    workerRetentionMs: nonNegativeNumberBodyField(body, "workerRetentionMs"),
    maxInactiveWorkers: nonNegativeNumberBodyField(body, "maxInactiveWorkers"),
    terminalOutboxRetentionMs: nonNegativeNumberBodyField(body, "terminalOutboxRetentionMs"),
    maxAcknowledgedTerminalOutboxEvents: nonNegativeNumberBodyField(body, "maxAcknowledgedTerminalOutboxEvents"),
    protectedTaskIds: stringListBodyField(body, "protectedTaskIds"),
    protectedWorkerIds: stringListBodyField(body, "protectedWorkerIds"),
  };
}

export function stringListQueryParam(url: URL, name: string): string[] | undefined {
  const values = url.searchParams.getAll(name).flatMap((value) => value.split(","));
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

export function nonNegativeNumberBodyField(body: Record<string, unknown> | null | undefined, name: string): number | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative number`);
  }
  return value;
}

export function stringListBodyField(body: Record<string, unknown> | null | undefined, name: string): string[] | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new BrokerError("bad_request", `${name} must be an array of strings`);
  }
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

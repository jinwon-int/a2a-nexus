/**
 * A2A 1.0 task push-notification configuration store (opt-in).
 *
 * Implements the CRUD surface the spec's Create/Get/List/Delete
 * TaskPushNotificationConfig methods operate on. This is the registration
 * layer only: it records where a task's push notifications should be
 * delivered. Actual delivery stays governed by the broker's terminal-outbox
 * receipt policy and the plugin's no-live-send defaults — registering a
 * config never performs a live send.
 *
 * Authorization & secrecy (enforced at the JSON-RPC layer):
 * - Every operation is authorized against an existing task; the caller must
 *   be a task party (requester/target/assigned worker) or hub/operator.
 * - Reads (get/list) redact delivery secrets (token, authentication
 *   credentials) via redactPushConfigSecrets — secrets are write-only.
 *
 * Durability: configs are restored from and persisted into the broker snapshot
 * path when the server wires this store to a BrokerStateStore. Retention prune
 * listeners still clear configs for pruned tasks so delivery secrets do not
 * outlive task lifecycle.
 */
import { randomUUID } from "node:crypto";
import { isRecord } from "../core/value-guards.js";

export interface PushNotificationAuthenticationInfo {
  schemes?: string[];
  credentials?: string;
}

export interface TaskPushNotificationConfig {
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
}

export type PushNotificationConfigSnapshot = TaskPushNotificationConfig[];

const MAX_CONFIGS_PER_TASK = 16;

export class PushNotificationConfigStore {
  /** taskId -> (configId -> config), insertion-ordered. */
  private readonly byTask = new Map<string, Map<string, TaskPushNotificationConfig>>();

  constructor(snapshot: PushNotificationConfigSnapshot = []) {
    this.restore(snapshot);
  }

  create(input: {
    taskId: string;
    id?: string;
    url: string;
    token?: string;
    authentication?: unknown;
  }): TaskPushNotificationConfig {
    const taskId = input.taskId?.trim();
    if (!taskId) {
      throw new PushConfigError("bad_request", "taskId is required");
    }
    const url = input.url?.trim();
    if (!isHttpUrl(url)) {
      throw new PushConfigError("bad_request", "url is required and must be an http(s) URL");
    }
    const authentication = normalizeAuthentication(input.authentication);
    const config: TaskPushNotificationConfig = {
      id: input.id?.trim() || randomUUID(),
      taskId,
      url,
      ...(input.token?.trim() ? { token: input.token.trim() } : {}),
      ...(authentication ? { authentication } : {}),
    };
    let configs = this.byTask.get(taskId);
    if (!configs) {
      configs = new Map();
      this.byTask.set(taskId, configs);
    }
    if (!configs.has(config.id) && configs.size >= MAX_CONFIGS_PER_TASK) {
      throw new PushConfigError("bad_request", `task already has the maximum ${MAX_CONFIGS_PER_TASK} push configs`);
    }
    configs.set(config.id, config);
    return { ...config };
  }

  get(taskId: string, id: string): TaskPushNotificationConfig {
    const config = this.byTask.get(taskId?.trim())?.get(id?.trim());
    if (!config) {
      throw new PushConfigError("not_found", "push notification config not found");
    }
    return { ...config };
  }

  list(taskId: string): TaskPushNotificationConfig[] {
    return [...(this.byTask.get(taskId?.trim())?.values() ?? [])].map((config) => ({ ...config }));
  }

  delete(taskId: string, id: string): void {
    const configs = this.byTask.get(taskId?.trim());
    if (!configs || !configs.delete(id?.trim())) {
      throw new PushConfigError("not_found", "push notification config not found");
    }
    if (configs.size === 0) {
      this.byTask.delete(taskId.trim());
    }
  }

  /** Drop all configs for a task (called when the task is pruned). */
  clearTask(taskId: string): void {
    this.byTask.delete(taskId?.trim());
  }

  retainTasks(taskIds: Iterable<string>): number {
    const retained = new Set([...taskIds].map((taskId) => taskId.trim()).filter(Boolean));
    let removed = 0;
    for (const taskId of [...this.byTask.keys()]) {
      if (!retained.has(taskId)) {
        this.byTask.delete(taskId);
        removed += 1;
      }
    }
    return removed;
  }

  snapshot(): PushNotificationConfigSnapshot {
    return [...this.byTask.values()].flatMap((configs) =>
      [...configs.values()].map((config) => clonePushConfig(config)),
    );
  }

  restore(snapshot: PushNotificationConfigSnapshot = []): void {
    this.byTask.clear();
    for (const item of snapshot) {
      const taskId = item.taskId?.trim();
      const id = item.id?.trim();
      const url = item.url?.trim();
      if (!taskId || !id || !isHttpUrl(url)) {
        continue;
      }
      let configs = this.byTask.get(taskId);
      if (!configs) {
        configs = new Map();
        this.byTask.set(taskId, configs);
      }
      if (configs.size >= MAX_CONFIGS_PER_TASK && !configs.has(id)) {
        continue;
      }
      let authentication: PushNotificationAuthenticationInfo | undefined;
      try {
        authentication = normalizeAuthentication(item.authentication);
      } catch {
        continue;
      }
      configs.set(id, clonePushConfig({
        taskId,
        id,
        url,
        ...(typeof item.token === "string" && item.token.trim() ? { token: item.token.trim() } : {}),
        ...(authentication ? { authentication } : {}),
      }));
    }
  }
}

function isHttpUrl(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeAuthentication(value: unknown): PushNotificationAuthenticationInfo | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PushConfigError("bad_request", "authentication must be an object");
  }
  const normalized: PushNotificationAuthenticationInfo = {};
  if (value.schemes !== undefined) {
    if (!Array.isArray(value.schemes) || !value.schemes.every((scheme): scheme is string => typeof scheme === "string")) {
      throw new PushConfigError("bad_request", "authentication.schemes must be an array of strings");
    }
    const schemes = value.schemes.map((scheme) => scheme.trim()).filter(Boolean);
    if (schemes.length > 0) {
      normalized.schemes = schemes;
    }
  }
  if (value.credentials !== undefined) {
    if (typeof value.credentials !== "string") {
      throw new PushConfigError("bad_request", "authentication.credentials must be a string");
    }
    const credentials = value.credentials.trim();
    if (credentials) {
      normalized.credentials = credentials;
    }
  }
  return normalized.schemes || normalized.credentials ? normalized : undefined;
}

function clonePushConfig(config: TaskPushNotificationConfig): TaskPushNotificationConfig {
  const schemes = Array.isArray(config.authentication?.schemes)
    ? config.authentication.schemes.filter((scheme): scheme is string => typeof scheme === "string")
    : undefined;
  const credentials = typeof config.authentication?.credentials === "string"
    ? config.authentication.credentials
    : undefined;
  const authentication = schemes?.length || credentials
    ? {
        ...(schemes?.length ? { schemes: [...schemes] } : {}),
        ...(credentials !== undefined ? { credentials } : {}),
      }
    : undefined;
  return {
    id: config.id,
    taskId: config.taskId,
    url: config.url,
    ...(typeof config.token === "string" ? { token: config.token } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

/**
 * Read-time redaction: a config's delivery secrets (token, authentication
 * credentials) are write-only. Reads (get/list) return existence + url and
 * mark secrets redacted so an authorized party cannot exfiltrate the raw
 * secret material a different party registered.
 */
export function redactPushConfigSecrets(config: TaskPushNotificationConfig): TaskPushNotificationConfig {
  const redacted: TaskPushNotificationConfig = { id: config.id, taskId: config.taskId, url: config.url };
  if (config.token !== undefined) {
    redacted.token = "[redacted]";
  }
  if (config.authentication) {
    redacted.authentication = {
      ...(config.authentication.schemes ? { schemes: config.authentication.schemes } : {}),
      ...(config.authentication.credentials !== undefined ? { credentials: "[redacted]" } : {}),
    };
  }
  return redacted;
}

export class PushConfigError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PushConfigError";
  }
}

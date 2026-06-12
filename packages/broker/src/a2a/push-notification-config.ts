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
 * Durability: configs are in-memory per broker process and do not survive a
 * restart (consistent with this opt-in, registration-only surface). A future
 * durable store can replace this class without changing the method contract.
 */
import { randomUUID } from "node:crypto";

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

const MAX_CONFIGS_PER_TASK = 16;

export class PushNotificationConfigStore {
  /** taskId -> (configId -> config), insertion-ordered. */
  private readonly byTask = new Map<string, Map<string, TaskPushNotificationConfig>>();

  create(input: {
    taskId: string;
    id?: string;
    url: string;
    token?: string;
    authentication?: PushNotificationAuthenticationInfo;
  }): TaskPushNotificationConfig {
    const taskId = input.taskId?.trim();
    if (!taskId) {
      throw new PushConfigError("bad_request", "taskId is required");
    }
    const url = input.url?.trim();
    if (!url || !/^[Hh][Tt][Tt][Pp][Ss]?:\/\//.test(url)) {
      throw new PushConfigError("bad_request", "url is required and must be an http(s) URL");
    }
    const config: TaskPushNotificationConfig = {
      id: input.id?.trim() || randomUUID(),
      taskId,
      url,
      ...(input.token?.trim() ? { token: input.token.trim() } : {}),
      ...(input.authentication ? { authentication: input.authentication } : {}),
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

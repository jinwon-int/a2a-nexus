/**
 * A2A 1.0 task push-notification configuration store (opt-in).
 *
 * Implements the CRUD surface the spec's Create/Get/List/Delete
 * TaskPushNotificationConfig methods operate on. This is the registration
 * layer only: it records where a task's push notifications should be
 * delivered. Actual delivery stays governed by the broker's terminal-outbox
 * receipt policy and the plugin's no-live-send defaults — registering a
 * config never performs a live send.
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

export class PushConfigError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PushConfigError";
  }
}

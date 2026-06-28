import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "../plugin-id.js";
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../config.js";
import type { RemoteNodeHandoffMetadata, SessionsSendHookEvent } from "./remote-node-handoff-adapter.js";
import { normalizeOptionalString } from "./value-guards.js";

export type RemoteHandoffVisibilityPolicyDecision =
  | {
      status: "allowed";
      visibility: "remote_handoff_allowed";
      remote: RemoteNodeHandoffMetadata;
    }
  | {
      status: "denied";
      visibility: "policy_denied";
      reason: string;
      remote?: RemoteNodeHandoffMetadata;
    }
  | {
      status: "missing_target";
      visibility: "missing_target";
      reason: string;
    }
  | {
      status: "approval_required";
      visibility: "approval_required";
      reason: string;
      remote: RemoteNodeHandoffMetadata;
    }
  | {
      status: "error";
      visibility: "error";
      reason: string;
      remote?: RemoteNodeHandoffMetadata;
    };

export type RemoteHandoffVisibilityPolicy = {
  allowedTargets?: ReadonlyArray<string> | ReadonlySet<string>;
  deniedTargets?: ReadonlyArray<string> | ReadonlySet<string>;
  allowedTaskKinds?: ReadonlyArray<string> | ReadonlySet<string>;
  deniedTaskKinds?: ReadonlyArray<string> | ReadonlySet<string>;
  allowedWorkspaces?: ReadonlyArray<string> | ReadonlySet<string>;
  deniedWorkspaces?: ReadonlyArray<string> | ReadonlySet<string>;
  approvalRequiredTargets?: ReadonlyArray<string> | ReadonlySet<string>;
  approvalRequiredTaskKinds?: ReadonlyArray<string> | ReadonlySet<string>;
  requireApprovalForLiveImpact?: boolean;
};

type RawPolicy = Record<string, unknown>;
function normalizeStringSet(
  value: unknown,
): ReadonlySet<string> | undefined {
  if (value instanceof Set) {
    return new Set([...value].map((item) => item.trim()).filter(Boolean));
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? new Set(items) : undefined;
}

function asSet(value: ReadonlyArray<string> | ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Set ? value : new Set(value);
}

function contains(value: string | undefined, configured: ReadonlyArray<string> | ReadonlySet<string> | undefined): boolean {
  if (!value) {
    return false;
  }
  return asSet(configured)?.has(value) === true;
}

function blocksByAllowlist(value: string | undefined, configured: ReadonlyArray<string> | ReadonlySet<string> | undefined): boolean {
  const set = asSet(configured);
  return Boolean(set && (!value || !set.has(value)));
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRawTaskInput(event: SessionsSendHookEvent): Record<string, unknown> | undefined {
  const raw = readObject(event.rawParams);
  return readObject(raw?.taskInput) ?? readObject(raw?.input) ?? readObject(raw?.caseContext);
}

function readWorkspaceId(event: SessionsSendHookEvent): string | undefined {
  const raw = readObject(event.rawParams);
  const taskInput = readRawTaskInput(event);
  const workspace = readObject(raw?.workspace) ?? readObject(taskInput?.workspace);
  return (
    normalizeOptionalString(workspace?.workspaceId) ??
    normalizeOptionalString(workspace?.id) ??
    normalizeOptionalString(raw?.workspaceId) ??
    normalizeOptionalString(taskInput?.workspaceId)
  );
}

function readPolicyContext(event: SessionsSendHookEvent): Record<string, unknown> | undefined {
  const taskInput = readRawTaskInput(event);
  const metadata = readObject(taskInput?.metadata);
  const caseContext = readObject(taskInput?.caseContext);
  return (
    readObject(taskInput?.policyContext) ??
    readObject(metadata?.policyContext) ??
    readObject(caseContext?.policyContext) ??
    readObject(event.rawParams && (event.rawParams as Record<string, unknown>).policyContext)
  );
}

function eventLooksLiveImpact(event: SessionsSendHookEvent): boolean {
  const context = readPolicyContext(event);
  return (
    context?.requiresApproval === true ||
    context?.liveImpact === true ||
    normalizeOptionalString(context?.targetEnvironment) === "live"
  );
}

function taskKind(event: SessionsSendHookEvent): string | undefined {
  return normalizeOptionalString(event.task?.intent);
}

function readConfigPolicy(
  config?: A2ABrokerAdapterPluginRuntimeConfig,
): RemoteHandoffVisibilityPolicy | undefined {
  const entryConfig = config?.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID]?.config as
    | Record<string, unknown>
    | undefined;
  const raw = readObject(entryConfig?.remoteHandoff) ?? readObject(entryConfig?.handoffPolicy);
  if (!raw) {
    return undefined;
  }
  return normalizePolicy(raw);
}

export function normalizePolicy(raw: RawPolicy): RemoteHandoffVisibilityPolicy {
  return {
    ...(normalizeStringSet(raw.allowedTargets) ? { allowedTargets: normalizeStringSet(raw.allowedTargets) } : {}),
    ...(normalizeStringSet(raw.deniedTargets) ? { deniedTargets: normalizeStringSet(raw.deniedTargets) } : {}),
    ...(normalizeStringSet(raw.allowedTaskKinds) ? { allowedTaskKinds: normalizeStringSet(raw.allowedTaskKinds) } : {}),
    ...(normalizeStringSet(raw.deniedTaskKinds) ? { deniedTaskKinds: normalizeStringSet(raw.deniedTaskKinds) } : {}),
    ...(normalizeStringSet(raw.allowedWorkspaces) ? { allowedWorkspaces: normalizeStringSet(raw.allowedWorkspaces) } : {}),
    ...(normalizeStringSet(raw.deniedWorkspaces) ? { deniedWorkspaces: normalizeStringSet(raw.deniedWorkspaces) } : {}),
    ...(normalizeStringSet(raw.approvalRequiredTargets)
      ? { approvalRequiredTargets: normalizeStringSet(raw.approvalRequiredTargets) }
      : {}),
    ...(normalizeStringSet(raw.approvalRequiredTaskKinds)
      ? { approvalRequiredTaskKinds: normalizeStringSet(raw.approvalRequiredTaskKinds) }
      : {}),
    ...(typeof raw.requireApprovalForLiveImpact === "boolean"
      ? { requireApprovalForLiveImpact: raw.requireApprovalForLiveImpact }
      : {}),
  };
}

export function evaluateRemoteHandoffVisibilityPolicy(params: {
  event: SessionsSendHookEvent;
  remote?: RemoteNodeHandoffMetadata;
  config?: A2ABrokerAdapterPluginRuntimeConfig;
  policy?: RemoteHandoffVisibilityPolicy;
}): RemoteHandoffVisibilityPolicyDecision {
  const policy = params.policy ?? readConfigPolicy(params.config) ?? { requireApprovalForLiveImpact: true };
  const remote = params.remote;
  if (!remote?.nodeId) {
    return {
      status: "missing_target",
      visibility: "missing_target",
      reason: "remote handoff target could not be resolved",
    };
  }

  const kind = taskKind(params.event);
  const workspaceId = readWorkspaceId(params.event);

  if (contains(remote.nodeId, policy.deniedTargets)) {
    return {
      status: "denied",
      visibility: "policy_denied",
      reason: `remote handoff target ${remote.nodeId} is denied by plugin policy`,
      remote,
    };
  }
  if (blocksByAllowlist(remote.nodeId, policy.allowedTargets)) {
    return {
      status: "denied",
      visibility: "policy_denied",
      reason: `remote handoff target ${remote.nodeId} is not in the plugin allowlist`,
      remote,
    };
  }
  if (contains(kind, policy.deniedTaskKinds)) {
    return {
      status: "denied",
      visibility: "policy_denied",
      reason: `remote handoff task kind ${kind} is denied by plugin policy`,
      remote,
    };
  }
  if (blocksByAllowlist(kind, policy.allowedTaskKinds)) {
    return {
      status: "denied",
      visibility: "policy_denied",
      reason: `remote handoff task kind ${kind ?? "<missing>"} is not in the plugin allowlist`,
      remote,
    };
  }
  if (contains(workspaceId, policy.deniedWorkspaces)) {
    return {
      status: "denied",
      visibility: "policy_denied",
      reason: `remote handoff workspace ${workspaceId} is denied by plugin policy`,
      remote,
    };
  }
  if (blocksByAllowlist(workspaceId, policy.allowedWorkspaces)) {
    return {
      status: "denied",
      visibility: "policy_denied",
      reason: `remote handoff workspace ${workspaceId ?? "<missing>"} is not in the plugin allowlist`,
      remote,
    };
  }
  if (
    contains(remote.nodeId, policy.approvalRequiredTargets) ||
    contains(kind, policy.approvalRequiredTaskKinds) ||
    (policy.requireApprovalForLiveImpact !== false && eventLooksLiveImpact(params.event))
  ) {
    return {
      status: "approval_required",
      visibility: "approval_required",
      reason: "remote handoff requires explicit operator approval before delegation",
      remote,
    };
  }

  return { status: "allowed", visibility: "remote_handoff_allowed", remote };
}

export function mapRemoteHandoffPolicyError(params: {
  error: unknown;
  remote?: RemoteNodeHandoffMetadata;
}): RemoteHandoffVisibilityPolicyDecision {
  return {
    status: "error",
    visibility: "error",
    reason: params.error instanceof Error ? params.error.message : String(params.error),
    ...(params.remote ? { remote: params.remote } : {}),
  };
}

// Wraps a base `sessions_send` hook with remote node-id awareness.
//
// The adapter detects when a send is targeting a remote A2A node-id (rather
// than a locally-visible session key) and either forwards through the inner
// hook with the node-id preserved, or surfaces an explicit "remote node-id
// requires A2A adapter" outcome when the broker adapter is inactive.
//
// Once core lands the pre-visibility seam (openclaw#50 / openclaw#51) this
// adapter becomes the registered `sessions_send` hook, ensuring that remote
// node-id targets do not trip core's `loadSessionEntry` "session not found"
// hard-fail before the plugin gets a turn.

import {
  shouldUseStandaloneBrokerSessionsSendAdapter,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../config.js";
import {
  resolveRemoteNodeId,
  type ResolveRemoteNodeIdOptions,
} from "./remote-node-resolver.js";
import type { A2AWakeAuditEvent } from "./wake-layer.js";
import { normalizeOptionalString } from "./value-guards.js";
import {
  evaluateRemoteHandoffVisibilityPolicy,
  mapRemoteHandoffPolicyError,
  type RemoteHandoffVisibilityPolicy,
  type RemoteHandoffVisibilityPolicyDecision,
} from "./handoff-visibility-policy.js";

export type RemoteNodeHandoffMetadataSource = "displayKey" | "sessionKey";

export type RemoteNodeHandoffMetadata = {
  nodeId: string;
  source: RemoteNodeHandoffMetadataSource;
};

export type SessionsSendHookEvent = {
  sessionKey: string;
  target?: {
    sessionKey?: string;
    displayKey?: string;
  };
  message: string;
  task?: {
    intent?: string;
    instructions?: string;
    constraints?: {
      maxPingPongTurns?: number;
    };
    runtime?: {
      waitRunId?: string;
      announceTimeoutMs?: number;
      maxPingPongTurns?: number;
      cancelTarget?: {
        kind?: string;
        sessionKey?: string;
        runId?: string;
      };
    };
    requester?: {
      sessionKey?: string;
      channel?: string;
    };
    correlationId?: string;
    parentRunId?: string;
  };
  rawParams?: unknown;
};

export type SessionsSendHookDelegatedDispatch = {
  kind: "a2a-broker";
  taskId: string;
  waitRunId?: string;
  cancelTarget?: {
    kind?: string;
    sessionKey?: string;
    runId?: string;
  };
  wake?: A2AWakeAuditEvent;
};

export type SessionsSendHookResult =
  | {
      handled: false;
      reason?: string;
      remote?: RemoteNodeHandoffMetadata;
      visibility?: RemoteHandoffVisibilityPolicyDecision["visibility"];
      policy?: RemoteHandoffVisibilityPolicyDecision;
    }
  | {
      handled: true;
      mode: "delegated";
      dispatch: SessionsSendHookDelegatedDispatch;
      remote?: RemoteNodeHandoffMetadata;
    }
  | {
      handled: true;
      mode: "direct";
      result: Record<string, unknown>;
      remote?: RemoteNodeHandoffMetadata;
    };

export type InnerSessionsSendHook = (
  event: SessionsSendHookEvent,
) => Promise<SessionsSendHookResult>;

export type RemoteNodeHandoffDeps = {
  innerHook: InnerSessionsSendHook;
  resolverOptions?: ResolveRemoteNodeIdOptions;
  visibilityPolicy?: RemoteHandoffVisibilityPolicy;
};
function detectRemoteTarget(
  event: SessionsSendHookEvent,
  options?: ResolveRemoteNodeIdOptions,
): RemoteNodeHandoffMetadata | undefined {
  const displayKey = normalizeOptionalString(event.target?.displayKey);
  if (displayKey) {
    const resolution = resolveRemoteNodeId(displayKey, options);
    if (resolution.remote) {
      return { nodeId: resolution.nodeId, source: "displayKey" };
    }
  }
  const sessionKey = normalizeOptionalString(event.target?.sessionKey);
  if (sessionKey) {
    const resolution = resolveRemoteNodeId(sessionKey, options);
    if (resolution.remote) {
      return { nodeId: resolution.nodeId, source: "sessionKey" };
    }
  }
  const fallbackSessionKey = normalizeOptionalString(event.sessionKey);
  if (fallbackSessionKey) {
    const resolution = resolveRemoteNodeId(fallbackSessionKey, options);
    if (resolution.remote) {
      return { nodeId: resolution.nodeId, source: "sessionKey" };
    }
  }
  return undefined;
}

export function createRemoteNodeHandoffAdapter(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: RemoteNodeHandoffDeps,
): InnerSessionsSendHook {
  return async (event) => {
    const remote = detectRemoteTarget(event, deps.resolverOptions);
    if (!remote) {
      return await deps.innerHook(event);
    }

    let policyDecision: RemoteHandoffVisibilityPolicyDecision;
    try {
      policyDecision = evaluateRemoteHandoffVisibilityPolicy({
        event,
        remote,
        config,
        policy: deps.visibilityPolicy,
      });
    } catch (error) {
      policyDecision = mapRemoteHandoffPolicyError({ error, remote });
    }

    if (policyDecision.status !== "allowed") {
      return {
        handled: false,
        reason: policyDecision.reason,
        ...("remote" in policyDecision && policyDecision.remote
          ? { remote: policyDecision.remote }
          : { remote }),
        visibility: policyDecision.visibility,
        policy: policyDecision,
      };
    }

    if (!shouldUseStandaloneBrokerSessionsSendAdapter(config)) {
      return {
        handled: false,
        reason: "remote node-id requires A2A adapter",
        remote,
        visibility: "policy_denied",
        policy: {
          status: "denied",
          visibility: "policy_denied",
          reason: "remote node-id requires A2A adapter",
          remote,
        },
      };
    }

    const result = await deps.innerHook(event);
    return { ...result, remote };
  };
}

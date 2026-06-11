import type { AgentCard } from "../a2a/agent-card.js";
import type { A2ATaskProjection } from "../a2a/task-projection.js";

export const A2A_COMPATIBILITY_PROFILE = {
  profileName: "A2A 1.0-compatible broker alpha profile",
  protocolVersion: "1.0",
  jsonRpcMethods: [
    "SendMessage",
    "GetTask",
    "ListTasks",
    "CancelTask",
    "SubscribeToTask",
    "GetExtendedAgentCard",
  ],
  brokerExtensionMethods: [
    "a2a.peer.status",
  ],
  unsupportedTransports: [
    "REST",
    "gRPC",
  ],
  unsupportedPushNotifications: true,
  unsupportedA2A03Compat: true,
  /**
   * A2A 1.0 version negotiation on /a2a/jsonrpc. Documented deviation: a
   * missing/empty A2A-Version header is served with 1.0 semantics instead of
   * the spec's 0.3 fallback (0.3 semantics are unsupported); an explicit
   * version we cannot honor is rejected with -32600.
   */
  versionNegotiation: {
    header: "A2A-Version",
    supported: ["1.0"],
    emptyFallback: "1.0 (spec says 0.3; deviation documented — 0.3 unsupported)",
  },
  taskStates: [
    "submitted",
    "working",
    "auth-required",
    "completed",
    "failed",
    "canceled",
    "rejected",
  ],
  // input-required is typed in A2ATaskState for spec completeness but has no
  // broker-internal source yet (reserved for a requester-input checkpoint).
  internalStatusToA2AState: {
    blocked: "auth-required",
    queued: "submitted",
    claimed: "working",
    running: "working",
    succeeded: "completed",
    failed: "failed",
    canceled: "canceled",
  },
  /**
   * Terminal projection refinements applied on top of the base status map:
   * a canceled task whose approvalOutcome.status is "rejected" projects as
   * the spec's `rejected` terminal state instead of generic `canceled`.
   */
  terminalRefinements: {
    canceled: { when: "approvalOutcome.status === \"rejected\"", state: "rejected" },
  },
  projectionKeys: ["artifacts", "id", "kind", "metadata", "status"],
  metadataKeys: [
    "approval",
    "assignedWorkerId",
    "cancellation",
    "claimedBy",
    "contextId",
    "createdAt",
    "error",
    "exchangeId",
    "intent",
    "internalStatus",
    "parentTaskId",
    "policyContext",
    "proposalId",
    "referenceTaskIds",
    "requester",
    "result",
    "target",
    "targetNodeId",
    "updatedAt",
    "workspace",
  ],
  listMetadataKeys: [
    "approval",
    "assignedWorkerId",
    "cancellation",
    "claimedBy",
    "contextId",
    "createdAt",
    "error",
    "exchangeId",
    "intent",
    "internalStatus",
    "parentTaskId",
    "policyContext",
    "proposalId",
    "referenceTaskIds",
    "requester",
    "resultSummary",
    "target",
    "targetNodeId",
    "updatedAt",
    "workspace",
  ],
} as const;

export const A2A_AGENT_CARD_GOLDEN: Pick<AgentCard, "protocolVersion" | "capabilities" | "defaultInputModes" | "defaultOutputModes"> = {
  protocolVersion: A2A_COMPATIBILITY_PROFILE.protocolVersion,
  capabilities: {
    streaming: true,
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

/**
 * Trust-model golden: the current broker AgentCard is intentionally unsigned.
 *
 * When card signing is implemented, this constant will be updated to include
 * a valid signature envelope. Until then, the absence of `signature` and
 * `signedExtensions` is the expected and tested behavior.
 */
export const A2A_AGENT_CARD_TRUST_GOLDEN = {
  /** Card signing is deferred. AgentCard.signature must remain undefined. */
  signatureRequired: false,
  /** Signed extensions are deferred. AgentCard.signedExtensions must remain undefined. */
  signedExtensionsRequired: false,
  /**
   * The broker trusts cards through transport auth (edge-secret +
   * requester-id), not through portable signed metadata.
   */
  trustModel: "transport-auth-only",
  /**
   * Secure-passport CallerContext operates at message metadata level, not
   * card level. The broker neither attaches nor validates CallerContext
   * signatures on SendMessage metadata.
   */
  securePassportMode: "passthrough",
} as const;

export const A2A_TASK_PROJECTION_GOLDEN: A2ATaskProjection = {
  id: "task-compat-golden",
  kind: "task",
  status: {
    state: "completed",
    timestamp: "2026-05-04T00:00:10.000Z",
    message: {
      role: "agent",
      parts: [{ text: "completed golden result" }],
    },
  },
  metadata: {
    internalStatus: "succeeded",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    exchangeId: "exchange-compat-golden",
    contextId: "exchange-compat-golden",
    parentTaskId: undefined,
    referenceTaskIds: undefined,
    proposalId: undefined,
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    claimedBy: "worker-a",
    workspace: undefined,
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:05.000Z",
    cancellation: undefined,
    error: undefined,
    result: {
      summary: "completed golden result",
      artifactIds: ["artifact-1"],
    },
    policyContext: undefined,
    approval: undefined,
  },
  artifacts: [{ id: "artifact-1" }],
};

/**
 * Pinned external A2A SDK/TCK references for drift-watch.
 *
 * These represent the official A2A project surfaces this broker tracks
 * compatibility against. The `pinned` fields should be updated when a
 * maintainer runs `npm run refresh:drift-refs` and verifies the broker
 * profile against the refreshed references.
 */
export const A2A_DRIFT_EXTERNAL_REFS = [
  {
    repo: "a2aproject/a2a-js",
    keyModules: [
      "tck/agent/index.ts",
      "src/types.ts",
      "card resolver",
      "JSON-RPC transport",
      "REST transport",
      "gRPC transport",
      "server handlers",
    ],
    checkedSurfaces: ["AgentCard", "Task", "Message", "Artifact", "JSON-RPC envelope", "transport abstractions"],
    pinned: { kind: "commit" as const, ref: "2e0a4e535e738ae12af2a757c7013cf60283fa71", refreshedAt: "2026-06-11T13:07:00KST" },
  },
  {
    repo: "a2aproject/a2a-python",
    keyModules: [
      "canonical type/proto compatibility modules",
      "client/server route helpers",
    ],
    checkedSurfaces: ["protocol buffer types", "JSON-RPC routes", "REST routes"],
    pinned: { kind: "commit" as const, ref: "b264a6ffafe156f684828edeaa3e526b9fcbe7b0", refreshedAt: "2026-06-11T12:25:00KST" },
  },
  {
    repo: "a2aproject/a2a-samples",
    keyModules: [
      "ITK (Interop Test Kit) / testlib",
      "multi-language samples",
    ],
    checkedSurfaces: ["interop test harness", "multi-language agent/server patterns"],
    pinned: { kind: "commit" as const, ref: "22b48d5e8f88a35b7098ab06257d0c2c3eb47c0b", refreshedAt: "2026-06-11T12:25:00KST" },
  },
];

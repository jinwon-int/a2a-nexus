import type { AgentCard } from "../a2a/agent-card.js";
import type { A2ATaskProjection } from "../a2a/task-projection.js";

export const A2A_COMPATIBILITY_PROFILE = {
  profileName: "A2A 1.0-compatible broker alpha profile",
  protocolVersion: "1.0",
  jsonRpcMethods: [
    "SendMessage",
    "SendStreamingMessage",
    "GetTask",
    "ListTasks",
    "CancelTask",
    "SubscribeToTask",
    "GetExtendedAgentCard",
    "CreateTaskPushNotificationConfig",
    "GetTaskPushNotificationConfig",
    "ListTaskPushNotificationConfigs",
    "DeleteTaskPushNotificationConfig",
  ],
  brokerExtensionMethods: [
    "a2a.peer.status",
  ],
  unsupportedTransports: [
    "REST",
    "gRPC",
  ],
  // Push-notification config CRUD is implemented but opt-in
  // (A2A_PUSH_NOTIFICATIONS_ENABLED): default card keeps
  // capabilities.pushNotifications false; enabled flips it true and the four
  // config methods register destinations (registration only — no live send).
  pushNotificationConfig: { optIn: true, methods: 4, capabilityWhenEnabled: true },
  // Push DELIVERY (live sends, retries, replay protection, receipts) remains
  // unsupported regardless of the opt-in: the config surface above is
  // registration-only and never performs a send.
  unsupportedPushDelivery: true,
  unsupportedA2A03Compat: true,
  /**
   * Trusted Conversation Plane (#1814, spec frozen #1861; C1–C6). The plane
   * is a BROKER surface — REST /conversations + peer relay /peer/conversations
   * — deliberately NOT part of the A2A 1.0 JSON-RPC method surface above;
   * SendMessage keeps its pre-existing exchange/task meaning. The AgentCard
   * `conversation` skill and the drift-watch gate pin this framing so the
   * plane is never advertised as A2A JSON-RPC conversation methods, and the
   * spec's non-goals stay advertised as unsupported.
   */
  conversationPlane: {
    spec: "a2a.conversation-envelope.v1 (#1861 frozen)",
    transport: "broker REST (/conversations) + peer relay (/peer/conversations/*)",
    a2aJsonRpcMethods: [] as string[],
    supported: [
      "same-broker broker↔worker / worker↔worker inbox poll + evidence-required consume (#1862)",
      "worker envelope signatures (opt-in enforce: A2A_CONVERSATION_WORKER_SIGNATURE_ENFORCE) (#1874)",
      "task result → bounded conversation reply; input-required resume exactly-once (#1863)",
      "cross-broker relay: cursor-addressed outbox pull/push, conversation:* peer scopes, request-bound sender proof when trust anchors are configured (#1864)",
      "cross-broker worker↔worker mirror replies + consume with deterministic ack lineage convergence; cursor-0 idempotent resync (#1865, #1876)",
      "delivery matrix for offline/stale/busy queue, expiry, and retry clarity (#1872)",
    ],
    unsupported: [
      "chat UI, personas, or long-term memory",
      "unbounded autonomous agent debate",
      "direct worker-to-worker sockets or worker credential sharing",
      "full broker DB or raw conversation replication",
      "provider-send success or polling exposure treated as processed / read receipt",
    ],
  },
  /**
   * A2A 1.0 signed agent cards: opt-in JWS (EdDSA or ES256) over the
   * RFC 8785 canonicalized card excluding the signatures field, enabled via
   * AGENT_CARD_SIGNING_KEY_FILE. Unsigned serving remains the default.
   */
  signedAgentCards: { optIn: true, algs: ["EdDSA", "ES256"], canonicalization: "RFC 8785" },
  /**
   * A2A 1.0 version negotiation on /a2a/jsonrpc. Documented deviation: a
   * missing/empty A2A-Version header is served with 1.0 semantics instead of
   * the spec's 0.3 fallback (0.3 semantics are unsupported); an explicit
   * version we cannot honor is rejected with the A2A-reserved
   * VersionNotSupportedError (-32009), not a generic -32600 Invalid Request.
   */
  /**
   * Result wire shapes: clients that explicitly negotiate A2A-Version get
   * the spec's bare Task/Message results (top-level contextId); header-less
   * legacy clients keep the historical { task } / { contextId, messageId,
   * task } envelopes.
   */
  responseShapes: { spec: "explicit A2A-Version header", legacy: "no header (plugin-era clients)" },
  versionNegotiation: {
    header: "A2A-Version",
    supported: ["1.0"],
    emptyFallback: "1.0 (spec says 0.3; deviation documented — 0.3 unsupported)",
    /** VersionNotSupportedError, A2A reserved family (#1912 D5 readback). */
    versionNotSupportedErrorCode: -32009,
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
  // input-required is produced by the awaiting_operator checkpoint
  // (contracts/a2a/checkpoint-interrupt.md): a worker human-interrupt pause
  // that clears when the requester answers in the same context or an
  // explicit resume is issued.
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
  /**
   * Interrupt refinements applied on top of the base status map: a claimed/
   * running task with an awaiting_operator checkpoint projects as the spec's
   * input-required interrupted state until requester input (a message into
   * the same context) or an explicit resume clears it.
   */
  interruptRefinements: {
    "claimed|running": { when: "checkpoint.state === \"awaiting_operator\"", state: "input-required" },
  },
  projectionKeys: ["artifacts", "id", "kind", "metadata", "status"],
  /**
   * ListTasks result ordering (#1912 D11). The spec requires status timestamp
   * descending; the broker's native read path sorts by createdAt, which
   * diverges once a task is claimed, run, or completed. The spec shape
   * re-sorts on `status.timestamp` (= completedAt ?? updatedAt) with an
   * ascending task-id tiebreak so the order is total and stable. The
   * header-less legacy envelope keeps createdAt ordering.
   */
  listTasksOrdering: {
    spec: "status.timestamp desc, task id asc",
    legacy: "createdAt desc (plugin-era ordering retained)",
  },
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

export const A2A_AGENT_CARD_GOLDEN: Pick<AgentCard, "protocolVersion" | "capabilities" | "defaultInputModes" | "defaultOutputModes" | "supportedInterfaces"> = {
  protocolVersion: A2A_COMPATIBILITY_PROFILE.protocolVersion,
  capabilities: {
    streaming: true,
    pushNotifications: false,
  },
  supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "https://broker.example.com/a2a/jsonrpc" }],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

/**
 * Trust-model golden: the broker AgentCard is unsigned by default, and card
 * signing is an implemented opt-in, not a deferred feature. When
 * AGENT_CARD_SIGNING_KEY_FILE is configured, server.ts signs the served card
 * via signAgentCard() (JWS EdDSA/ES256 over the RFC 8785 canonicalized
 * card); with no key configured the card is served unsigned, exactly as
 * before. drift-watch pins this fixture against that shipped code path so
 * the fixture can never again describe signing as unimplemented while the
 * server signs (#1912 F1).
 */
export const A2A_AGENT_CARD_TRUST_GOLDEN = {
  /**
   * Signatures are opt-in, not required: AgentCard.signatures stays absent
   * unless a signing key is configured. This stays false only while unsigned
   * serving remains a supported default — it no longer means "signing is
   * unimplemented".
   */
  signatureRequired: false,
  /** Signed extensions remain unimplemented: no code path produces them. */
  signedExtensionsRequired: false,
  /**
   * Inbound trust only: the broker authenticates peers and workers through
   * transport auth (edge-secret + requester-id), not through signed metadata
   * they present. Independent of the opt-in signature the broker's own card
   * can carry for clients to verify.
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

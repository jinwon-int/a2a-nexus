// Type-only server contracts extracted for #1289 L-server-2.
// Keep runtime route/server logic in server.ts or purpose-built route modules;
// this module should remain declarations-only so importing it has no side effects.

import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";

import type { AgentCard } from "./a2a/agent-card.js";
import type { BoundedPoller } from "./github/bounded-poller.js";
import type { GitHubIngestionService } from "./github/ingestion.js";
import type { BrokerRuntimeHotLimitOptions } from "./broker-runtime-config.js";
import type { Alert, AlertScanResult } from "./core/alert-projection.js";
import type { BrokerError, BrokerRetentionPolicy, InMemoryA2ABroker } from "./core/broker.js";
import type { A2AHttpSignatureKeyRegistry } from "./core/request-security.js";
import type { BrokerStateStore, SqliteBrokerLoadSource } from "./core/store.js";
import type { ReviewLineageRolloutMode } from "./core/review-lineage-store.js";
import type { OperatorSummary } from "./http/dashboard-response.js";
import type { TaskReadinessMode } from "./task-readiness.js";
import type { SharedStateServingFenceProbeV1 } from "./shared-state-serving-fence-v1.js";

export interface BrokerBuildInfo {
  component: string;
  revision: string;
  source: string;
  builtAt?: string;
  runtime?: string;
  image?: {
    tag?: string;
    digest?: string;
  };
}

/**
 * #1772: a host environment variable that contradicts the provenance baked
 * into the image at build time.
 *
 * The env value is ignored — the image-baked value is authoritative — but the
 * disagreement is reported so the misconfiguration is visible instead of
 * silently shaping `/health.build`. `ignored` is sanitized with the same rules
 * as the surfaced value, and is `"redacted"` when the env value did not
 * survive sanitization.
 */
export interface BrokerBuildProvenanceConflict {
  field: "version" | "revision" | "builtAt" | "runtime" | "imageTag" | "imageDigest";
  envVar: string;
  ignored: string;
  authoritative: string;
}

export type BrokerPersistenceQueueMode = "inline" | "worker_thread";
export type BrokerPersistenceQueueState = "disabled" | "healthy" | "saturated" | "draining" | "aborted" | "unavailable";

export interface BrokerPersistenceQueueDiagnostics {
  kind: "broker.persistence.queue";
  enabled: boolean;
  mode: BrokerPersistenceQueueMode;
  state: BrokerPersistenceQueueState;
  capacity: number | null;
  queued: number;
  active: number;
  inFlight: number;
  available: number | null;
  closing: boolean;
  aborted: boolean;
  lastErrorCode?: BrokerError["code"] | string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}

export type BrokerPersistenceQueueDiagnosticsProvider = () => BrokerPersistenceQueueDiagnostics | undefined;

export interface OperatorSnapshotEvent {
  summary: OperatorSummary;
  alerts: AlertScanResult;
}

interface OperatorSummaryUpdateEvent {
  summary: OperatorSummary;
  alerts: AlertScanResult;
}

interface OperatorAlertEvent {
  alert: Alert;
}

export type OperatorEventName =
  | "operator-snapshot"
  | "operator-summary-update"
  | "operator-alert-opened"
  | "operator-alert-resolved";

export type OperatorEventPayload =
  | OperatorSnapshotEvent
  | OperatorSummaryUpdateEvent
  | OperatorAlertEvent;

export interface BufferedOperatorEvent {
  seq: number;
  event: OperatorEventName;
  data: OperatorEventPayload;
}

export interface OperatorReplayWindow {
  oldestBufferedSeq: number | null;
  currentSeq: number;
}


export type A2AHttpSignatureWorkerAuthMode = "off" | "optional" | "strict";
export type A2AHttpSignatureWorkerKeySource = "empty" | "inline" | "file";

export interface A2AHttpSignatureVerifiedWorker {
  keyid: string;
  requesterId: string;
  publicKeyPem?: string;
  scopes?: readonly string[];
}

export interface BrokerServerOptions extends BrokerRuntimeHotLimitOptions {
  host?: string;
  port?: number;
  serviceName?: string;
  publicBaseUrl?: string;
  stateFile?: string;
  /** Dedicated V1 fence file. Env: `BROKER_SHARED_STATE_FILE`. */
  sharedStateFile?: string;
  sqliteFile?: string;
  persistenceBackend?: "json-file" | "sqlite";
  sqliteLoadSource?: SqliteBrokerLoadSource;
  workerOfflineAfterSec?: number;
  /**
   * Minimum interval between unchanged durable worker heartbeat writes. In-memory
   * read paths stay fresh on every heartbeat; SQLite persistence is bounded to
   * keep heartbeat churn off the hot request path. Env:
   * `BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS`.
   */
  workerHeartbeatPersistIntervalMs?: number;
  rateLimitWindowSec?: number;
  rateLimitMaxRequests?: number;
  workerRateLimitWindowSec?: number;
  workerRateLimitMaxRequests?: number;
  enforceRequesterIdentity?: boolean;
  edgeSecret?: string;
  /** HMAC authority key for broker-only live-task approval admission. Env: `A2A_LIVE_APPROVAL_SIGNING_KEY`. */
  liveApprovalSigningKey?: string;
  /** Explicit dev-only opt-in for unauthenticated local broker startup. Env: `A2A_ALLOW_INSECURE_DEV=1`. */
  allowInsecureDev?: boolean;
  /**
   * Worker-plane A2A HTTP Signature rollout mode.
   * - off: no route-level signature checks (default/backwards compatible)
   * - optional: verify signed worker requests when signature headers are present
   * - strict: require valid signatures for worker lifecycle/poll/mutation routes
   * Env: `A2A_HTTP_SIGNATURE_WORKER_AUTH`.
   */
  a2aHttpSignatureWorkerAuth?: A2AHttpSignatureWorkerAuthMode;
  /** In-memory key registry for worker HTTP Signature verification. */
  a2aHttpSignatureKeyRegistry?: A2AHttpSignatureKeyRegistry;
  /** JSON file containing public worker HTTP Signature keys. Env: `A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE`. */
  a2aHttpSignatureKeyRegistryFile?: string;
  /**
   * Shared secret for GitHub webhook deliveries. When set, POST /github/webhook
   * requires a valid X-Hub-Signature-256 header (HMAC-SHA256 of the raw body).
   */
  githubWebhookSecret?: string;
  agentCard?: AgentCard;
  /**
   * Enable A2A 1.0 task push-notification config CRUD and advertise
   * capabilities.pushNotifications on the agent card. Falls back to
   * A2A_PUSH_NOTIFICATIONS_ENABLED. Off by default.
   */
  pushNotificationsEnabled?: boolean;
  /** PEM private key file (Ed25519 or EC P-256) for A2A 1.0 signed agent cards. Falls back to AGENT_CARD_SIGNING_KEY_FILE. */
  agentCardSigningKeyFile?: string;
  /** Optional JWS kid header for the agent-card signature. Falls back to AGENT_CARD_SIGNING_KID. */
  agentCardSigningKid?: string;
  /**
   * Result-provenance broker countersigning posture (#1382 G2, #1389 deploy gap).
   * Falls back to A2A_RESULT_PROVENANCE_COUNTERSIGN.
   * - "enforce": the broker MUST countersign worker result provenance — startup
   *   fails loudly if no signing key is configured, so a code-vs-env skew is
   *   caught at boot instead of failing worker submissions later.
   * - "auto" (default): countersign when a signing key is present, otherwise pass
   *   the worker-signed result through un-countersigned (never fails the task).
   * - "off": provenance is passed through untouched — a kill switch that never
   *   verifies or countersigns.
   */
  resultProvenanceCountersign?: "enforce" | "auto" | "off";
  /**
   * JSON file with the declarative worker-class policy document (#1355 G1),
   * schema a2a.broker.policy.v1. Falls back to A2A_BROKER_POLICY_FILE. The
   * document's own `mode` field decides warn vs enforce; a configured-but-
   * invalid or unreadable document fails startup loudly. Unset = no policy
   * evaluation (legacy behavior).
   */
  brokerPolicyFile?: string;
  /**
   * JSON file with the deterministic anonymous knowledge snapshot (#1373 K1),
   * schema a2a.injected-knowledge.v1, built offline by
   * scripts/build-injected-knowledge.mjs. Falls back to
   * A2A_INJECTED_KNOWLEDGE_FILE. A configured-but-invalid or unreadable
   * snapshot fails startup loudly. Unset = no injection (legacy behavior).
   */
  injectedKnowledgeFile?: string;
  /**
   * Accept-path finalizer-verdict posture (#1383 V-c): off (default) | warn |
   * enforce. Falls back to A2A_FINALIZER_VERDICT_ENFORCEMENT. An invalid value
   * fails startup loudly. Applies only to tasks that opt in via
   * payload.requireFinalizerVerdict; off keeps completion byte-identical.
   */
  finalizerVerdictEnforcement?: "off" | "warn" | "enforce";
  /**
   * Accepted forward clock skew (seconds) on the A2A HTTP signature `created`
   * timestamp (#1402). Falls back to A2A_SIGNATURE_CLOCK_SKEW_SEC (default 2).
   * 0 restores strict zero-tolerance behavior; `expires` is always strict.
   */
  a2aSignatureClockSkewSeconds?: number;
  /**
   * JSON finalizer keyring file ({ "keys": { "finalizer:<id>": "<SPKI PEM>" } })
   * for in-broker static-key verdict signature verification (#1383 V-c). Falls
   * back to A2A_FINALIZER_KEYRING_FILE. Invalid file fails startup loudly; unset
   * defers signature authenticity to the repo merge gate.
   */
  finalizerKeyringFile?: string;
  /**
   * JSON trust-anchor file ({ "<brokerId>": "<SPKI public key PEM>" }) for
   * the cross-broker terminal-brief receiver. When set, every inbound
   * projection must carry a request-bound `senderProof` (a JWS over
   * { brokerId, bodyHash, issuedAt, nonce } signed by the pinned key) —
   * NOT merely a signed agent card, which is public and replayable.
   * Enabling this fail-closes peers that do not emit senderProof yet, so
   * roll out sender-side support before pinning a peer's key. Falls back
   * to CROSS_BROKER_SENDER_PROOF_KEYS_FILE. Unset keeps today's behavior.
   */
  crossBrokerSenderProofKeysFile?: string;
  /**
   * JSON peer credential registry file mapping a peer broker id →
   * { secretSha256, scopes, status? } for minimum-scope cross-broker handoff
   * authorization (contracts/a2a/broker-handoff-protocol.md peer scopes
   * handoff:create / handoff:status / handoff:evidence / handoff:comment).
   * The file must be root-only (0600-style permissions; loading fails closed
   * otherwise) and stores sha256 digests, never raw secrets. Falls back to
   * A2A_PEER_CREDENTIALS_FILE. Unset = peer credentials not provisioned
   * (legacy role + edge-secret behavior is unchanged).
   */
  peerCredentialsFile?: string;
  /**
   * Peer handoff scope gate mode: off | auto (default) | enforce. Falls back
   * to A2A_PEER_HANDOFF_SCOPE_MODE. `auto` verifies peer credentials whenever
   * the caller presents x-a2a-peer-broker-id/x-a2a-peer-secret headers (bad or
   * under-scoped credentials fail closed; header-less callers keep legacy
   * behavior). `enforce` additionally fail-closes the cross-broker projection
   * routes when no peer credential is presented — startup fails loudly if
   * enforce is configured without a registry file, so a code-vs-env skew is
   * caught at boot.
   */
  peerHandoffScopeMode?: "off" | "auto" | "enforce";
  /**
   * Enable the embedded default A2A agent: register a built-in worker and
   * drive its tasks in-process so a worker-less SendMessage produces a task
   * (single-agent / conformance mode). Falls back to A2A_DEFAULT_AGENT_MODE.
   * Off by default; production multi-worker routing is unchanged.
   */
  defaultAgentMode?: boolean;
  stateStore?: BrokerStateStore;
  broker?: InMemoryA2ABroker;
  /**
   * Optional O(1) worker-thread persistence queue counters for /health, /schedz,
   * and operator dashboard surfaces. The provider must not perform DB or network IO.
   */
  persistenceQueueDiagnostics?: BrokerPersistenceQueueDiagnosticsProvider;
  /** Max worker-thread durable write ACK wait in ms before returning retryable 503. */
  persistenceQueueAckTimeoutMs?: number;
  /**
   * Max bytes allowed for CreateTaskRequest.payload. Keeps large sourceBundle
   * blobs from entering hot task rows/read paths; externalize larger bundles.
   * Env: `BROKER_MAX_TASK_PAYLOAD_BYTES` (or legacy `A2A_MAX_TASK_PAYLOAD_BYTES`).
   */
  maxTaskPayloadBytes?: number;
  retentionPolicy?: Partial<BrokerRetentionPolicy>;
  maxSnapshotBytes?: number;
  trustedProxy?: boolean;
  staleReaperEnabled?: boolean;
  staleReaperIntervalSec?: number;
  staleReaperOlderThanSec?: number;
  /** Idle threshold before a live wave plan is flagged wave.stalled; 0 disables the wave sweep. */
  waveStaleAfterSec?: number;
  /**
   * Max times the stale-task reaper (or manual requeue) may recycle a single task back to
   * `queued` before dead-lettering it to `failed`. `0` disables the cap. Env:
   * `BROKER_MAX_REQUEUE_ATTEMPTS`.
   */
  maxRequeueAttempts?: number;
  /** Optional broker identity exposed on health/worker registration and stamped onto new tasks as broker-of-record. Env: `A2A_BROKER_ID` or `BROKER_ID`. */
  brokerId?: string;
  /** Team/tenant identity stamped onto new tasks for lifecycle ownership checks. Env: `A2A_TEAM_ID`. */
  teamId?: string;
  /** Definition-of-Ready lint rollout mode for patch/implementation task creation. Env: `A2A_TASK_READINESS_MODE` or `BROKER_TASK_READINESS_MODE` (`warn` default, `enforce` fail-closed). */
  taskReadinessMode?: TaskReadinessMode;
  /**
   * Bounded PR review lineage telemetry mode. Env:
   * `A2A_REVIEW_LINEAGE_MODE` (`off` default; `record` is observational).
   */
  reviewLineageMode?: ReviewLineageRolloutMode;
  /**
   * NCLEX evaluation receipt keyring file (JSON `{ "keys": { "<kid>": "<spki pem>" } }`).
   * Env: `A2A_NCLEX_EVALUATION_KEYRING_FILE`. Unset disables the
   * `/nclex-evaluations/*` surface entirely (default-off); configured-but-invalid
   * fails startup loudly.
   */
  nclexEvaluationKeyringFile?: string;
  /**
   * SSE heartbeat interval for `/a2a/tasks/:id/events`. Comments (`: heartbeat ...`) keep
   * intermediaries from timing out idle subscriptions. `0` disables heartbeats. Env:
   * `TASK_SUBSCRIBE_HEARTBEAT_SEC`.
   */
  taskSubscribeHeartbeatSec?: number;
  /**
   * Enables the read-only `a2a.peer.status` JSON-RPC method. Default-off until
   * canary proof validates the Round 7 wake-layer rollout. Env: `A2A_PEER_STATUS_ENABLED`.
   */
  peerStatusEnabled?: boolean;
  /**
   * Optional deployment/build revision to expose on health and operator status surfaces.
   * Env priority: `A2A_BROKER_REVISION`, `BROKER_RELEASE_REVISION`, `RELEASE_REVISION`.
   */
  buildRevision?: string;
  /** Backward-compatible alias for older draft callers. Prefer `buildRevision`. */
  releaseRevision?: string;
  /** Optional broker version override. Defaults to package metadata. Env: `A2A_BROKER_VERSION`. */
  version?: string;
  /** Optional generated build-info JSON path. Defaults to bundled `dist/build-info.json` when present. */
  buildInfoFile?: string;
  /**
   * HTTP server `keepAliveTimeout` in ms. Controls how long idle TCP connections are
   * kept open by the server. Must be shorter than `headersTimeoutMs`.
   * Default: 62000ms (62s), chosen to exceed the default 30s worker heartbeat interval
   * so heartbeat connections survive between beats.
   * The Node.js default is 5000ms, which forces every heartbeat to open a new connection.
   * Env: `A2A_SERVER_KEEPALIVE_TIMEOUT_MS`.
   */
  keepAliveTimeoutMs?: number;
  /**
   * HTTP server `headersTimeout` in ms. Controls how long the server waits to receive
   * the complete request headers. Must exceed `keepAliveTimeoutMs` (Node.js requirement,
   * otherwise the server throws on listen). Defaults to `keepAliveTimeoutMs + 10000`.
   * Env: `A2A_SERVER_HEADERS_TIMEOUT_MS`.
   */
  headersTimeoutMs?: number;
}

export interface BrokerStaleReaperStatus {
  enabled: boolean;
  intervalSec: number;
  olderThanSec: number;
  waveStaleAfterSec: number;
  maxRequeueAttempts: number;
  lastRunAt?: string;
  lastRequeued?: number;
  lastDeadLettered?: number;
  totalDeadLettered: number;
  lastError?: string;
  runCount: number;
}

export interface BrokerServerRuntime {
  server: Server;
  handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>;
  broker: InMemoryA2ABroker;
  /**
   * Enter drain mode (#1405): every response gains `Connection: close`, task
   * poll/claim are refused with 503 broker_draining + Retry-After, and idle
   * keep-alive connections are closed. In-flight submission/lifecycle routes
   * keep working. Idempotent. Driven by the SIGTERM drain window
   * (A2A_SHUTDOWN_DRAIN_MS) in server-lifecycle.ts.
   */
  beginDrain: () => void;
  /** Whether the server is currently draining for shutdown. */
  isDraining: () => boolean;
  /**
   * Re-read the serving fence through the P1 loss monitor. A latched
   * `lost_fence` stays not-ready for the process lifetime. Tests use this
   * so a stolen row can be observed without waiting for the timer.
   */
  evaluateSharedStateLossMonitor: () => SharedStateServingFenceProbeV1;
  /** Run the stale-task reaper sweep once. Returns the number of requeued tasks. */
  runStaleReaperSweep: () => number;
  /** Stop the periodic stale-task reaper timer (if started). Safe to call multiple times. */
  stopStaleReaper: () => void;
  /** Current reaper configuration and last-run observations for ops visibility. */
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  /** GitHub /a2a assign ingestion service — exposed for diagnostics and direct calls. */
  githubIngestion: GitHubIngestionService;
  /** Bounded poller for periodic GitHub event fetch — exposed for diagnostics. */
  boundedPoller?: BoundedPoller;
  /** Stop the bounded poller (if started). Safe to call multiple times. */
  stopPoller: () => void;
  /** Drain and terminate the worker-thread persistence queue, if enabled. */
  closeWorkerPersistence: () => Promise<void>;
  config: {
    host: string;
    port: number;
    serviceName: string;
    publicBaseUrl: string;
    stateFile: string;
    sqliteFile?: string;
    persistenceBackend: "json-file" | "sqlite";
    sqliteLoadSource?: SqliteBrokerLoadSource;
    workerOfflineAfterSec: number;
    workerHeartbeatPersistIntervalMs: number;
    rateLimitWindowSec: number;
    rateLimitMaxRequests: number;
    workerRateLimitWindowSec: number;
    workerRateLimitMaxRequests: number;
    enforceRequesterIdentity: boolean;
    edgeSecret?: string;
    a2aHttpSignatureWorkerAuth: A2AHttpSignatureWorkerAuthMode;
    a2aHttpSignatureWorkerKeyCount: number;
    a2aHttpSignatureWorkerKeySource: A2AHttpSignatureWorkerKeySource;
    githubWebhookSecret?: string;
    retentionPolicy: BrokerRetentionPolicy;
    maxSnapshotBytes: number;
    maxHotRuntimeNonTerminalTasks: number;
    maxHotRuntimeTerminalTasks: number;
    maxHotRuntimeAuditEvents: number;
    maxHotRuntimeHeartbeatAuditEvents: number;
    maxHotRuntimeTerminalOutboxEvents: number;
    trustedProxy: boolean;
    staleReaperEnabled: boolean;
    staleReaperIntervalSec: number;
    staleReaperOlderThanSec: number;
    waveStaleAfterSec: number;
    maxRequeueAttempts: number;
    taskSubscribeHeartbeatSec: number;
    peerStatusEnabled: boolean;
    brokerId: string;
    version: string;
    build: BrokerBuildInfo;
  };
}

# Platform-Independent A2A Adapter Interface Contract (v0)

> **v0 Draft (2026-05-28):** This contract defines the abstract, platform-independent A2A Adapter
> Interface that any agent platform (OpenClaw, Hermes, Claude Code, Codex, standalone HTTP client)
> can implement to participate in the A2A Plane. It is a companion to the
> [task lifecycle](./task-lifecycle.md), [terminal semantics](./terminal-semantics.md),
> and [adapter receipt capability](./adapter-receipt-capability.md) contracts.
>
> **Status:** Interface contract only. No adapter implementation, provider send, terminal-outbox ACK,
> DB mutation, or any prohibited action is authorized by this document.
>
> **Lane issue:** [a2a-plane#475](https://github.com/jinwon-int/a2a-plane/issues/475)
> **Parent:** [a2a-plane#500](https://github.com/jinwon-int/a2a-plane/issues/500)
> **Run:** `a2a-team1-roadmap-wave3-bridge-adapter-20260528T123200KST`

---

## 1. Motivation

Today all A2A broker-facing adapters are tightly coupled to the OpenClaw Gateway and plugin SDK.
Hermes workers bypass this with poll-mode scripts, but poll mode sacrifices real-time events and
creates two maintenance surfaces.

A platform-independent adapter interface lets any agent runtime:

- Receive and claim A2A tasks over a standard contract
- Report status and heartbeat without OpenClaw internals
- Submit terminal evidence (PR/Done/Block) through a uniform shape
- Optionally subscribe to push or wake notifications
- Be verified via a standard conformance test suite

---

## 2. Adapter Type Definitions

### 2.1 `A2AAdapterId`

A stable, unique identifier for an adapter instance. Used in task routing, broker registration,
and evidence attribution.

```typescript
interface A2AAdapterId {
  /** Stable adapter identifier (e.g., "hermes-agent-reference-worker"). */
  readonly id: string;
  /** Platform family: "openclaw" | "hermes" | "claude-code" | "codex" | "http-cli" | "custom". */
  readonly platform: string;
  /** Human-readable display name. */
  readonly displayName: string;
}
```

### 2.2 `A2AAdapterCapabilities`

Declared capabilities that the broker uses for task routing and capability gating.

```typescript
interface A2AAdapterCapabilities {
  /** Task intents this adapter can handle. */
  readonly supportedIntents: string[];
  /**
   * Transport mechanisms the adapter supports for receiving tasks.
   * At least one must be present.
   */
  readonly transports: Array<{
    kind: "http-poll" | "sse" | "webhook" | "plugin-sdk" | "websocket" | "grpc";
    /** Push endpoint (for webhook/sse/websocket transports). Omitted for http-poll. */
    endpointUrl?: string;
    /** Maximum concurrent tasks this adapter can handle (0 = unlimited). */
    maxConcurrent?: number;
  }>;
  /** Whether the adapter supports heartbeat. */
  readonly heartbeatSupported: boolean;
  /** Whether the adapter supports wake/notification push. */
  readonly wakeSupported: boolean;
  /** Whether the adapter can checkpoint and resume. */
  readonly checkpointSupported: boolean;
  /** Custom capability flags (adapter-defined). */
  readonly custom?: Record<string, unknown>;
}
```

### 2.3 `A2ATaskRequest`

The minimal task request envelope that any adapter must be able to receive and interpret.

```typescript
interface A2ATaskRequest {
  /** Broker-assigned task identifier. */
  readonly taskId: string;
  /** Idempotency key for replay safety. */
  readonly idempotencyKey: string;
  /** Task intent: one of the broker's recognized intent vocabulary. */
  readonly intent: string;
  /** Task input payload. */
  readonly input: unknown;
  /** Optional expected output schema, for structured tasks. */
  readonly expectedOutput?: unknown;
  /** Broker base URL for lifecycle API calls. */
  readonly brokerUrl: string;
  /** Requester identity (redacted). */
  readonly requester?: {
    id: string;
    kind?: string;
    role?: string;
  };
  /** Correlation ID for traceability. */
  readonly correlationId?: string;
  /** Parent run ID for aggregated rounds. */
  readonly parentRunId?: string;
  /** Deadline or timeout hint (ISO-8601 duration or absolute timestamp). */
  readonly deadline?: string;
}
```

### 2.4 `A2ATaskStatus`

Standard task status vocabulary that all platforms must map to.

| Status | Meaning | Terminal? |
| --- | --- | --- |
| `accepted` | Task received, queued for processing | No |
| `claimed` | Adapter has claimed ownership of the task | No |
| `running` | Adapter is actively working on the task | No |
| `paused` | Task execution suspended at a checkpoint | No |
| `awaiting_operator` | Task waiting for human operator input | No |
| `succeeded` | Task completed successfully | Yes |
| `failed` | Task failed with error | Yes |
| `cancelled` | Task was cancelled (operator, timeout, block) | Yes |
| `blocked` | Task blocked; cannot proceed safely | Yes |

### 2.5 `A2AEvidence`

Standard terminal evidence payload that any adapter can produce.

```typescript
interface A2AEvidence {
  /** Evidence kind. */
  readonly kind: "start" | "pr" | "done" | "block";
  /** Task ID this evidence belongs to. */
  readonly taskId: string;
  /** Summary (redacted; no secrets, paths, or tokens). */
  readonly summary: string;
  /** Optional PR URL (when kind="pr"). */
  readonly prUrl?: string;
  /** Optional Done URL (when kind="done"). */
  readonly doneUrl?: string;
  /** Optional Block URL (when kind="block"). */
  readonly blockUrl?: string;
  /** Stable deduplication key (idempotencyKey + kind, broker-assigned). */
  readonly dedupeKey: string;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  /** Whether this evidence payload has been redacted of secrets. */
  readonly redacted: boolean;
  /** Extra metadata (additive; broker tolerates unknown keys). */
  readonly [extra: string]: unknown;
}
```

### 2.6 `A2AHeartbeat`

Standard heartbeat payload for adapter health monitoring.

```typescript
interface A2AHeartbeat {
  /** Adapter ID. */
  readonly adapterId: string;
  /** Current task statuses for tasks this adapter is handling. */
  readonly activeTasks: Array<{
    taskId: string;
    status: string;
    checkpoint?: string;
  }>;
  /** Adapter-local health metric. */
  readonly health: "ok" | "degraded" | "unavailable";
  /** Timestamp. */
  readonly timestamp: string;
}
```

### 2.7 `A2AAdapterConfig`

Configuration that an adapter receives at initialization.

```typescript
interface A2AAdapterConfig {
  /** Broker endpoint URL. */
  readonly brokerUrl: string;
  /** Adapter identity. */
  readonly adapterId: A2AAdapterId;
  /** Adapter capabilities. */
  readonly capabilities: A2AAdapterCapabilities;
  /** Authentication configuration (platform-specific; redacted in evidence). */
  readonly auth?: {
    /** Auth header value (ephemeral, never persisted in evidence). */
    readonly bearerToken?: string;
    /** Edge secret for broker auth. */
    readonly edgeSecret?: string;
  };
  /** Transport-specific configuration. */
  readonly transport?: Record<string, unknown>;
  /** Poll interval in ms (for http-poll transport). */
  readonly pollIntervalMs?: number;
  /** Deadline timeout in ms. */
  readonly defaultDeadlineMs?: number;
}
```

---

## 3. Abstract Adapter Interface

### 3.1 `A2AAdapter` interface

```typescript
interface A2AAdapter {
  // ── Identity ──────────────────────────────────────────────

  /** Stable adapter identifier. */
  readonly id: string;
  /** Platform family string. */
  readonly platform: string;

  // ── Lifecycle ─────────────────────────────────────────────

  /** Initialize the adapter with broker config. Must be called before start(). */
  initialize(config: A2AAdapterConfig): Promise<void>;

  /** Start the adapter's task processing loop. Idempotent. */
  start(): Promise<void>;

  /** Gracefully shut down the adapter. Idempotent. */
  shutdown(): Promise<void>;

  // ── Task operations ───────────────────────────────────────

  /**
   * Accept and claim a task from the broker.
   * Returns the task request and a callback for status updates.
   *
   * For http-poll adapters: called after pollTasks finds a pending task.
   * For push adapters: called when the broker delivers a new task.
   */
  claimTask(taskId: string): Promise<{
    request: A2ATaskRequest;
    update: (status: A2ATaskStatus, evidence?: Partial<A2AEvidence>) => Promise<void>;
  }>;

  /**
   * Poll for pending tasks assigned to this adapter.
   * Required for http-poll transport; optional for push transports.
   */
  pollTasks(filter?: {
    status?: string;
    workerId?: string;
  }): Promise<A2ATaskRequest[]>;

  // ── Status & heartbeat ────────────────────────────────────

  /** Report a status update to the broker. */
  reportStatus(taskId: string, status: A2ATaskStatus): Promise<void>;

  /** Send a heartbeat to the broker. */
  heartbeat(payload: A2AHeartbeat): Promise<void>;

  // ── Evidence ──────────────────────────────────────────────

  /** Submit terminal evidence to the broker. */
  submitEvidence(evidence: A2AEvidence): Promise<{
    accepted: boolean;
    evidenceUrl?: string;
    dedupeKey: string;
  }>;

  // ── Wake / Notification (optional) ────────────────────────

  /**
   * Receive a wake notification from the broker.
   * Only supported when capabilities.wakeSupported === true.
   */
  onWake?(notification: {
    taskId: string;
    message: string;
    targetSessionKey?: string;
  }): Promise<void>;
}
```

### 3.2 Core contract guarantees

1. **Idempotency**: All broker-facing calls (`claimTask`, `reportStatus`, `submitEvidence`)
   are idempotent. Replaying the same call with the same key returns the same result.
2. **No-ACK from submitEvidence**: `submitEvidence` returns `accepted: true` on broker acceptance only
   — this is receipt level 1 (accepted-send). It is never terminal ACK, operator-visible receipt,
   or read receipt.
3. **Redaction**: All evidence payloads must be redacted of secrets, tokens, host-specific paths,
   and raw session dumps before submission.
4. **Ordering**: Tasks are processed at-least-once. Duplicate delivery is handled by the broker's
   idempotency key deduplication. Adapters must not assume exactly-once delivery.
5. **Non-terminal failure**: A failed `claimTask` or `reportStatus` call must not leave the adapter
   in a state where it has started task execution without broker visibility. Adapters should fail
   closed on broker communication errors.
6. **Minimum supported transport**: Every adapter must support at least `http-poll` transport,
   which polls for pending tasks at a configurable interval. Push transports (SSE, webhook, WebSocket,
   gRPC) are optional enhancements.
7. **Cancellation observance**: When an adapter receives a `cancelled` status response after calling
   `reportStatus` or receives a `cancelled` task from `pollTasks`, it must stop mutable operations
   (file writes, git operations, branch changes) and not open or push a new PR.

### 3.3 Non-goals

- The interface does not define how the adapter internally connects to its AI runtime (OpenClaw agent,
  Hermes Agent, Claude Code, Codex, etc.). That is an implementation detail.
- The interface does not define how configuration secrets or credentials reach the adapter.
  Platform-specific keychains, environment variables, or config files are out of scope.
- The interface does not replace the broker's own lifecycle API. It is a convenience abstraction
  that maps to the existing broker REST API (as defined in `broker-handoff-protocol.md`,
  `worker-registration.md`, and `hermes-worker-integration` spec).
- The interface does not define adapter-to-adapter communication. Cross-adapter coordination
  (e.g., handoff) remains broker-mediated per `broker-handoff-protocol.md`.

---

## 4. Transport Modes

### 4.1 HTTP-Poll (mandatory)

The minimal transport. Adapter calls `pollTasks` to discover pending work and `claimTask` to acquire it.

```
Loop:
  pollTasks({ status: "pending", workerId: <adapterId> })
  for each task:
    claimTask(taskId)
    execute task
    submitEvidence({ kind: "done" | "pr" | "block", ... })
    reportStatus(taskId, "succeeded" | "failed" | "blocked")
```

### 4.2 SSE / Server-Sent Events (optional)

Adapter connects to a broker SSE endpoint and receives task events in real time:

```
Connect:
  GET /tasks/events?workerId=<adapterId>
  Accept: text/event-stream

Events:
  event: task.created
  data: { taskId, idempotencyKey, ... }

  event: task.cancelled
  data: { taskId, reason }
```

### 4.3 Webhook (optional)

Broker pushes tasks to the adapter's `endpointUrl` via POST:

```
POST <adapter endpointUrl>
Content-Type: application/json

{
  "event": "task.created",
  "taskId": "...",
  ...
}
```

### 4.4 Plugin SDK (OpenClaw-specific)

The existing OpenClaw plugin SDK path, where the adapter registers Gateway handlers for
`a2a.task.request`, `a2a.task.update`, `a2a.task.cancel`, etc. This is the current OpenClaw-native
transport that the migration path aims to wrap behind the abstract interface.

---

## 5. Receipt Level Mapping

Every adapter method that touches a provider or broker send maps to the receipt levels defined in
[Terminal Result Semantics](./terminal-semantics.md) and
[Adapter Receipt Capability](./adapter-receipt-capability.md).

| Adapter operation | Receipt level | ACK-safe? | Evidence field |
|---|---|---|---|
| `claimTask` accepted by broker | Level 0 (no receipt) | No | `claimTaskAccepted: true` |
| `submitEvidence` accepted by broker | Level 1 (accepted-send) | No | `providerAccepted: true` |
| Broker confirms evidence is in GitHub comment | Level 2 (requester-visible) | No | `requesterVisible: true` |
| Operator explicitly confirms receipt | Level 3 (operator-visible) | No | `operatorVisible: true` |
| Operator provides ACK-safe receipt proof | Level 4 (terminal ACK) | Yes | `terminalAckSafe: true` |

All adapter implementations must document their maximum achievable receipt level in their
capability declaration.

---

## 6. Conformance Requirements

A conforming platform-independent A2A adapter must:

1. Implement the `A2AAdapter` interface (or language equivalent).
2. Support at least the `http-poll` transport.
3. Accept `A2ATaskRequest`, report `A2ATaskStatus`, and submit `A2AEvidence` per the schemas above.
4. Send heartbeats at a configurable interval (when `heartbeatSupported`).
5. Observe cancellation signals and stop mutable work promptly.
6. Redact all evidence payloads: no tokens, secrets, host paths, raw session dumps, or
   OpenClaw workspace files (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
   `IDENTITY.md`, `.openclaw/**`).
7. Declare `maxReceiptLevel` in capabilities (the highest receipt level the adapter can achieve).
8. Pass the adapter conformance fixture validation (see §7).

Non-conformance behaviors:

| Violation | Action |
| --- | --- |
| Adapter skips redaction on evidence | Evidence is rejected by broker |
| Adapter claims higher receipt level than supported | Broker degrades receipt level |
| Adapter does not observe cancellation | Cancel may escalate to force-cancel |
| Adapter does not send heartbeats when `heartbeatSupported=true` | Broker marks adapter as stale |

---

## 7. Fixture

A machine-readable fixture for adapter interface conformance is maintained at:

- `fixtures/contract/platform-adapter-interface.json`

The fixture validates:
- `A2AAdapterId` schema conformance
- `A2AAdapterCapabilities` schema conformance
- `A2ATaskRequest` envelope parsing
- `A2AEvidence` payload shape and redaction markers
- Receipt level mapping correctness
- HTTP-poll transport flow (poll → claim → execute → evidence)

Validated via:
```sh
node test/conformance/check-platform-adapter-interface.mjs
```

---

## 8. Safety Boundaries

1. **Source-only**: This contract defines an interface and conformance fixture. It does not deploy,
   restart, send, mutate, or approve.
2. **No live provider send**: Adapter `submitEvidence` returns broker acceptance evidence only.
   Provider send is a separate non-ACK step.
3. **No terminal-outbox ACK**: This contract does not mutate terminal-outbox ACK rows.
4. **No database mutation**: No production database, queue, or WAL is read or written.
5. **No secret movement**: Evidence payloads are explicitly redacted. No secret values, tokens,
   or private paths are transmitted.
6. **Runtime/bootstrap hygiene**: No `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
   `IDENTITY.md`, or `.openclaw/**` files enter the branch or artifact evidence.

---

## 9. Related Documents

| Document | Relation |
| --- | --- |
| [Adapter Receipt Capability Contract](./adapter-receipt-capability.md) | Defines receipt levels for non-OpenClaw/Hermes/spool adapters |
| [Worker Registration Contract](./worker-registration.md) | Defines how workers register with the broker |
| [Broker Handoff Protocol](./broker-handoff-protocol.md) | Defines broker-to-broker task handoff |
| [Hermes Worker Integration Spec](../../docs/specs/hermes-worker-integration/spec.md) | Defines the Hermes HTTP-poll worker contract |
| [A2A Task Lifecycle](./task-lifecycle.md) | Defines task states and transitions |
| [Terminal Result Semantics](./terminal-semantics.md) | Defines receipt levels and ACK boundary |
| [OpenClaw-Core Extraction Plan](../../packages/openclaw-plugin-a2a/docs/migration-plan.md) | Defines the OpenClaw plugin extraction path |
| [A2A Constitution](../../docs/a2a-constitution.md) | Defines A2A Plane principles |

---

## 10. Migration Path Summary

See [Adapter Migration Path](../../docs/adapter-migration-path.md) for the phased migration plan from
OpenClaw-only to platform-independent adapter support.

## 11. Decision Record: Issue #475 Adapter Interface

### Accepted

| Item | Decision | Location |
|---|---|---|
| Abstract A2AAdapter interface | Accepted. Defines lifecycle, task operations, status, evidence, and optional wake. | §3 |
| HTTP-poll as mandatory minimum | Accepted. Every adapter must support polling; push transports are optional. | §3.2, §4.1 |
| Four transport modes | Accepted. HTTP-poll, SSE, webhook, plugin SDK. | §4 |
| Receipt level mapping per existing model | Accepted. Adapter capabilities declare `maxReceiptLevel`. | §5 |
| Conformance fixture | Accepted. Machine-readable fixture at `fixtures/contract/platform-adapter-interface.json`. | §7 |
| Redaction requirement | Accepted. All evidence must be redacted; broker rejects unredacted evidence. | §3.2, §6 |
| Idempotency guarantee | Accepted. All broker-facing calls are idempotent. | §3.2 |

### Deferred / Rejected

| Item | Decision | Rationale |
|---|---|---|
| gRPC transport | Deferred. No existing A2A Plane use case requires gRPC. Revisit if a broker-side gRPC endpoint is added. | No implementation demand; adds complexity without current benefit. |
| WebSocket transport | Deferred. SSE covers the push use case for v0. WebSocket would add bidirectional state management complexity. | SSE is simpler and sufficient for task event streams. |
| Adapter federation (cross-broker adapter registration) | Deferred. Cross-broker coordination is handled by `broker-handoff-protocol.md`, not the adapter interface itself. | Adapter interface is per-broker; handoff is a separate concern. |
| Live adapter deployment | Rejected for v0. This is an interface contract only. Live adapter rollout is Phase 2+ per the migration path. | Safety gate: no production deploy. |
| Non-HTTP transports (e.g., file-based, message queue) | Deferred. File-based or MQ transports can be added as new transport kinds in a future version. | No current A2A Plane requirement. |

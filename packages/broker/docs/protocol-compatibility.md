# A2A protocol compatibility matrix

This matrix is the public compatibility statement for `a2a-broker` before the
repository is presented as an open A2A implementation.

## Current supported profile

**Current profile: A2A 1.0-compatible broker alpha profile.**

The broker exposes A2A 1.0-style discovery and JSON-RPC task operations while
keeping broker-owned task lifecycle, worker routing, policy gates, and evidence
semantics as its source of truth. The surface is compatible enough for clients
that can use the documented methods and tolerate broker metadata, but it is not
yet a claim of full conformance to every official A2A 1.0 operation or optional
binding.

The agent card currently advertises:

- `protocolVersion: "1.0"`
- JSON-RPC endpoint: `/a2a/jsonrpc`
- public discovery: `/.well-known/agent-card.json`
- streaming capability: `true`, implemented as SSE discovered via
  `SubscribeToTask`
- push notification capability: `false` by default; opt-in via
  `A2A_PUSH_NOTIFICATIONS_ENABLED`, which flips the card to `true` and enables
  the task push-notification config methods `CreateTaskPushNotificationConfig`,
  `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`,
  `DeleteTaskPushNotificationConfig` (registration only — no live send; every
  operation is authorized against an existing task and reads redact delivery
  secrets; configs are in-memory per process)
- default input/output modes: `text`
- public projected task states: `submitted`, `working`, `auth-required`, `completed`, `failed`, `canceled`, `rejected`
  - `blocked` (approval-gated) projects as `auth-required`; a task terminated by an operator approval rejection (`approvalOutcome.status === "rejected"`) projects as `rejected` instead of `canceled`
  - `input-required` is produced by the `awaiting_operator` checkpoint (worker human-interrupt per `contracts/a2a/checkpoint-interrupt.md`); a requester message into the same context — or `POST /tasks/:id/resume` — clears it back to `working`
  - an active checkpoint is a real lifecycle gate: `complete`/`fail` are rejected until resume or cancel (cancel clears the checkpoint), the stale-task reaper never requeues a checkpointed task, and a checkpoint that is not resumed within the broker's `checkpointTimeoutMs` (default 24h, contract §1.4/§2.3) is canceled by the stale sweep
  - `awaiting_operator` checkpoints carry a contract §2.2 `decisionType` (`safety_gate` / `ambiguous_scope` / `approval_required` (default) / `conflict_detected`) and optional bounded `artifactRefs`; checkpoint `reason` (≤500 chars), `checkpointId` (≤128 chars, `[A-Za-z0-9._:-]`), and refs are bounded/shape-checked before becoming operator-visible state
  - **documented deviation from contract §1.4**: the broker retains the worker assignment across a checkpoint (the same claim resumes) instead of releasing it; release-and-reclaim semantics are deferred until worker capability gating for `checkpoint` lands

## Compatibility matrix

| Area | Current support | Compatibility notes | Conformance gate |
|---|---|---|---|
| Protocol version | A2A 1.0-compatible broker alpha profile. | The broker uses 1.0-style agent cards and JSON-RPC method names, but still documents broker-specific metadata and lifecycle. No 0.3 compatibility mode is implemented. Each `supportedInterfaces` entry carries its own `protocolVersion`, which v1.0 marks REQUIRED (`protocol_version = 4` in a2a.proto v1.0.1). **Documented deviation:** the card-level `protocolVersion` is retained for existing readers even though the v1.0 `AgentCard` message has no such field; both are emitted from one value so they cannot disagree. No interface sets `tenant` — the broker serves a single agent and performs no tenant routing, so leaving it unset is the compliant state. | `src/a2a/protocol-compatibility.test.ts` asserts the advertised agent-card protocol version and capability flags; `src/a2a/drift-watch.test.ts` pins the per-interface version against the profile. |
| Multi-tenancy | **Not implemented — intended direction.** No `AgentInterface` declares a `tenant`, which is a compliant state (clients send `tenant` only when an interface sets one). A request carrying an **undeclared** tenant is rejected with `-32602` rather than silently ignored. | Silently ignoring it would leave a client believing it is routed to an isolated tenant that does not exist; rejecting surfaces the mismatch on the first request. The matching branch is already implemented, so declaring interface tenants later routes correctly. `tenant` is **not** an authorization boundary — it is client-supplied and opaque, and authorization runs per request independently of it. Unmet prerequisites are enumerated in `A2A_COMPATIBILITY_PROFILE.multiTenancy.blockers` (shared-state/HA #1504, per-tenant credentials, read-path scoping audit, worker/workspace isolation, tenant binding in signed evidence). | `src/a2a/json-rpc.test.ts` covers reject/accept/mismatch and that a matching tenant never substitutes for authorization; `src/a2a/drift-watch.test.ts` pins the stance against the shipped card. |
| Declared authentication | The card declares the edge-secret credential as a ProtoJSON `apiKeySecurityScheme` (`securitySchemes.edgeSecret`, header `x-a2a-edge-secret`) plus a matching `securityRequirements` entry — **only when the deployment actually enforces it**. | `assertEdgeSecret` is a no-op when no secret is configured, so an unconditional declaration would advertise authentication the broker does not perform; absence therefore means "this deployment enforces nothing", not "unimplemented". `/livez` and `/.well-known/agent-card.json` stay public so discovery works before a client holds the credential. `x-a2a-requester-id` is deliberately **not** declared: it is a caller-asserted identity, not a credential. Encoding verified against a2a.proto v1.0.1, the generated schema bundle, and official a2a-js v1.0.1 types — not the OpenAPI-flavoured `{ type, in }` form. | `src/a2a/drift-watch.test.ts` pins both postures and boots a real server to assert the served card. |
| Signed agent cards | Opt-in JWS signature (`EdDSA` for Ed25519, `ES256` for EC P-256) over the RFC 8785 canonicalized card excluding the `signatures` field, served on `/.well-known/agent-card.json` when `AGENT_CARD_SIGNING_KEY_FILE` is set. | Unsigned serving stays the default; a configured-but-unreadable key fails startup loudly. Verification helper exported for receiving agents/tests. | `src/a2a/agent-card-signing.test.ts` (canonicalization goldens, sign/verify roundtrips, tamper detection) + server integration tests. |
| Result provenance countersigning | When a worker submits a result carrying `result.provenance`, the broker verifies the worker signature against the registered key and countersigns it. The posture is set by `A2A_RESULT_PROVENANCE_COUNTERSIGN`: `enforce` (broker MUST countersign — **startup fails loudly if no signing key is configured**, using the same key as `AGENT_CARD_SIGNING_KEY_FILE`), `auto` (default — countersign when a key is present, otherwise pass the worker-signed result through un-countersigned), or `off` (kill switch — provenance passes through untouched, no verify/countersign). | A deployed build never starts rejecting worker submissions because the broker signer env/key has not landed yet (the #1389 deploy-order gap): only explicit `enforce` fails closed, and it fails at **startup**, not per-task. A non-empty unrecognized value is a loud config error. | `src/server-worker-signature-route-gate.test.ts` (all three postures: enforce startup guard, auto pass-through, off kill switch) + `src/core/provenance.test.ts`. |
| Message send | `SendMessage` creates a new exchange + task when `metadata.targetNodeId` is present and no context exists; appends to an existing exchange when `metadata.exchangeId` or `metadata.contextId` is present. Text input is accepted as a string, `{ text }`, or text `parts`. | New-context sends require an already registered target worker. Supported metadata includes `intent`, `targetNodeId`, `assignedWorkerId`, `exchangeId`/`contextId`, `parentMessageId`, transport/channel/node/session/trace fields. Task projections expose `metadata.contextId` and `metadata.referenceTaskIds` so follow-up/refinement tasks can stay in the same context while pointing back to prior immutable work. | Existing server JSON-RPC tests cover create/follow-up behavior; the compatibility gate pins the public task projection shape returned by these calls. |
| Streaming message send | `SendStreamingMessage` (single non-batch request only) creates the exchange/task like `SendMessage`, then answers with an SSE stream of JSON-RPC result envelopes correlated by the request id: an opening `task-snapshot` event followed by `task-status-update` events until the task is terminal. SSE event ids reuse the broker task-event sequence, so `Last-Event-Id` reconnects on `/a2a/tasks/:id/events` resume the same stream. | Batch-embedded `SendStreamingMessage` is rejected with `-32600`; streaming notifications (no id) fall through to the generic layer. Context-only sends with no active task return a unary JSON-RPC response. | Server tests cover the SSE envelope stream and the batch rejection. |
| Streaming | `SubscribeToTask` returns the current task snapshot and an SSE URL. Live events are served by `GET /a2a/tasks/:id/events`. | JSON-RPC POST does not carry the event stream itself. SSE events are `task-snapshot` and `task-status-update`; terminal updates set `final: true` and close the stream. | Existing SSE tests cover snapshot, update, terminal close, heartbeat, replay, and auth behavior. |
| Task get/list | `GetTask` returns `{ task: A2ATaskProjection }`. `ListTasks` returns `{ tasks: A2ATaskListProjection[] }`. | **Spec path** (explicit `A2A-Version`) accepts only the pinned v1.0.1 filter vocabulary — `tenant`, `contextId`, `status` (`TASK_STATE_*`, matched at the projection boundary), `historyLength` (honored trivially: projections carry no per-task history), and `includeArtifacts`. Unknown keys reject `-32602` instead of dropping silently. **Bounded pagination (#1912 D3)**: `pageSize` defaults to 50 and clamps to the documented maximum of 100 (values below the minimum of 1 reject); `pageToken` is an opaque checksummed cursor bound to its exact filter scope — forged, tampered, stale, or scope-mismatched tokens reject `-32602`; `statusTimestampAfter` filters inclusively on the projected status timestamp; `nextPageToken` carries the continuation cursor and `totalSize` counts all matching tasks before paging. **Documented deviation:** an explicit `includeArtifacts=false` is accepted but artifacts are still returned — elision is the D4 gap, tracked in #1912. The header-less legacy envelope keeps its historical broker-oriented filters (`exchangeId`/`contextId`, internal `status`, `targetNodeId`, `proposalId`, `intent`, `claimedBy`, `assignedWorkerId`). List results on the spec shape order by `status.timestamp` descending (ties broken by ascending task id) per A2A v1.0; legacy retains its historical `createdAt`-descending order. | `src/a2a/list-tasks-spec-filters.test.ts` pins the spec-vocabulary matrix incl. projected-state subtleties; `src/a2a/list-tasks-spec-pagination.test.ts` pins default/clamp bounds, cursor walk/idempotency, scope binding, and timestamp filtering; the compatibility gate pins the task projection keys, list projection summary behavior, internal-status to A2A-state mapping, and the spec-shape list ordering. |
| Cancel | `CancelTask` cancels a task and fans out to non-terminal descendants linked by `parentTaskId`. Repeated cancel is idempotent. | Requester identity enforcement can require `x-a2a-requester-id` to match the explicit actor. Broker cancellation metadata is exposed under `metadata.cancellation`. Terminal tasks (`succeeded`, `failed`, `canceled`) are immutable: reassign, complete, fail, and cancel all no-op or reject for terminal tasks. | Existing JSON-RPC/server tests cover cancel state mapping and idempotent fan-out semantics. |
| Push notifications | Config CRUD implemented, **opt-in** via `A2A_PUSH_NOTIFICATIONS_ENABLED` (default off, card advertises `capabilities.pushNotifications: false`). Enabled mode serves the four 1.0 config methods (proto rpc names; `taskId`/`task_id` params accepted) and flips the card capability. **Delivery is not implemented**: registration only — no live send, retries, replay protection, or receipt semantics. | Disabled mode answers `PushNotificationNotSupportedError` (`-32003` with `a2a-protocol.org` ErrorInfo) — the capability is absent, not the method. Every operation is authorized against an existing task (task party or hub/operator); reads redact delivery secrets; configs are in-memory and released when retention prunes the task. Terminal outbox APIs remain broker/operator integration surfaces, not A2A push conformance. | Drift-watch pins `unsupportedPushDelivery` plus the opt-in config profile and the default-off card capability; server tests cover enabled CRUD, disabled `-32003`, auth, redaction, and prune cleanup. |
| Agent card/discovery | `GET /.well-known/agent-card.json` exposes the broker card, endpoint URL, provider metadata if configured, capabilities, and broker skills. `GetExtendedAgentCard` requires the `extendedAgentCard` capability: without it the method fails with `AuthenticatedExtendedCardNotConfiguredError` (`-32007`) instead of silently serving the public card. Worker capability cards provide a separate AgentCard-compatible registry subset for assignment-safety queries. | Public discovery exposes broker-level capabilities, not individual worker private state. Worker capability cards are validated before query results are usable and public-safe cards must omit broker URLs, workspace ids, secrets, and raw metadata. Worker capacity/health APIs remain separate broker/operator surfaces. | Agent-card server tests, worker capability-card tests, and the compatibility gate pin the advertised profile. |
| Artifacts | Task projections expose `artifacts: [{ id }]` from `task.result.artifactIds` or request `artifactIds`. | The broker preserves richer runner evidence and artifacts in internal result/evidence records; the A2A projection intentionally exposes only stable artifact ids today. Full A2A `Artifact`/`Part` expansion is deferred. | The compatibility gate pins artifact id projection behavior. |
| Tenant/context IDs | Exchanges map to A2A-style contexts. `SendMessage` accepts `metadata.contextId` as an alias for `exchangeId`; task projections expose both `metadata.exchangeId` and `metadata.contextId`. | There is no separate tenant isolation claim in the A2A profile. Multi-tenant context grouping beyond broker requester/target metadata is a non-goal for this profile. Follow-up task records may carry `referenceTaskIds` identifiers for lineage without exposing prior task internals. | Existing JSON-RPC tests cover `contextId` alias behavior; compatibility tests pin `contextId`/`referenceTaskIds` projection. |
| AgentCard trust / signing | Card signing (JWS) is **implemented opt-in** — the served broker AgentCard is signed when `AGENT_CARD_SIGNING_KEY_FILE` is set (EdDSA/ES256 over the RFC 8785 canonicalization), and served **unsigned** otherwise, which is the current default (see the "Signed agent cards" row). Worker capability cards remain unsigned; trust for the unsigned default rests on transport auth (edge-secret + requester-id). Secure-passport `CallerContext` validation is still deferred — see `docs/agent-card-trust-model.md`. | The public AgentCard TypeScript shape exposes no placeholder `signature`/`signedExtensions` fields; a real `signatures` block is added only when a signing key is configured. | `src/a2a/protocol-compatibility.test.ts` asserts the default (unsigned) card omits `signature`/`signedExtensions` and projects the implemented opt-in from the single code-backed source `A2A_COMPATIBILITY_PROFILE.signedAgentCards`; `src/a2a/agent-card-signing.test.ts` covers sign/verify roundtrips. |
| Authentication | Edge-secret protection and requester identity headers protect the broker facade. | Official A2A auth-flow guidance is not fully modeled. OAuth/OIDC discovery and dynamic client auth are deferred. | Request-security and SSE auth tests cover current fail-closed behavior. |
| Peer status extension | `a2a.peer.status` is the canonical broker-specific method. The legacy `PeerStatus` alias is deprecated and retained only for compatibility during a migration window. | This method is outside the A2A 1.0 compatibility claim and must be treated as an OpenClaw/broker extension. New clients must use `a2a.peer.status`; compatibility callers should migrate off `PeerStatus`. | Peer-status tests cover canonical extension semantics and one deprecated-alias compatibility path separately. |

## Non-goals for the current profile

- Full official A2A 1.0 conformance across every optional operation and binding.
- A2A 0.3 compatibility mode.
- Push notification **delivery**, retries, replay protection, and receipt semantics
  as an A2A push implementation (config CRUD is implemented opt-in,
  registration only — see the compatibility matrix above).
- Pagination/filtering/history-length parity beyond the current broker task filters.
- Rich official `Artifact`/`Part` projection beyond stable artifact ids.
- OAuth/OIDC or other dynamic public auth-flow discovery.
- Portable trust-anchor distribution and key rotation/revocation infrastructure
  for AgentCard signing. Card signing itself (JWS) is implemented opt-in (see the
  compatibility matrix above); operational key management remains out of scope.
  The unsigned default relies on transport auth (edge-secret + requester-id). See
  `docs/agent-card-trust-model.md`.
- Secure-passport `CallerContext` attachment, extraction, or signature validation.
  The broker passes through message metadata without interpreting the
  secure-passport extension key.
- Treating broker-specific extension methods such as `a2a.peer.status` as part of
  the A2A compatibility claim.
- Treating the Trusted Conversation Plane (#1814, spec frozen #1861) as A2A
  protocol methods. The conversation plane (broker REST `/conversations` +
  peer relay `/peer/conversations/*`) is a broker surface: `SendMessage` keeps
  its exchange/task meaning and `conversationPlane.a2aJsonRpcMethods` stays
  `[]`. Its own non-goals (chat UI, autonomous agent debate, direct
  worker-to-worker sockets, full broker DB / raw conversation replication,
  provider-send success or polling exposure as processed / read receipt)
  remain unsupported — see `conversationPlane` in
  `src/fixtures/a2a-protocol-compatibility.ts` and the drift-watch gate.

## Broker-status to A2A 1.0 task-state mapping

The broker maintains its own internal task lifecycle with precision states
(`blocked`, `queued`, `claimed`, `running`, `succeeded`, `failed`, `canceled`).
Public A2A 1.0 projections collapse these into five standard states:

| Broker internal status | A2A 1.0 projected state | Terminal? |
|------------------------|------------------------|----------|
| `blocked`              | `submitted`            | no        |
| `queued`               | `submitted`            | no        |
| `claimed`              | `working`              | no        |
| `running`              | `working`              | no        |
| `succeeded`            | `completed`            | **yes**   |
| `failed`               | `failed`               | **yes**   |
| `canceled`             | `canceled`             | **yes**   |

**Terminal immutability:** Once a task reaches `succeeded`, `failed`, or
`canceled`, the broker rejects further lifecycle mutations. The projected A2A
state cannot transition out of the corresponding terminal state.

This mapping is the source of truth implemented in `src/a2a/task-projection.ts`
and verified by `src/a2a/protocol-compatibility.test.ts` and the terminal
immutability tests in `src/core/broker.test.ts`.

## Compatibility change process

Any change to the public A2A shape must update this document and the compatibility
gate in the same pull request. In particular, update both before changing:

- agent-card `protocolVersion`, capability flags, endpoint URL, or input/output
  modes;
- JSON-RPC method names or parameter aliases;
- `A2ATaskProjection` / `A2ATaskListProjection` keys;
- internal task-status to A2A task-state mapping;
- artifact projection behavior;
- the stated support/non-goal status of push notifications, pagination, auth, or
  0.3 compatibility.

See also:

- `docs/a2a-protocol.md` for canonical broker protocol semantics.
- `docs/a2a-drift-watch.md` for the explicit drift-watch gate against official A2A SDK/TCK surfaces.
- `docs/api-spec-draft.md` for route-level request/response examples.
- `docs/v1-acceptance-handoff.md` for the publication and handoff gate.
- `docs/agent-card-trust-model.md` for the AgentCard signing trust model and deferred decisions.

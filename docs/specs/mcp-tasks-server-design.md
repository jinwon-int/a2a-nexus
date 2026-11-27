# MCP Tasks server: process, transport, and authentication design

> Status: design draft (no-live). Tracking: [#2591](https://github.com/jinwon-int/a2a-nexus/issues/2591) phase 2.
> Builds on the no-live contract [`mcp-tasks-facade.md`](mcp-tasks-facade.md) (contract v0, #2596).
> Nothing in this document is deployed. Starting a server, connecting it to a
> live broker, or changing broker configuration needs a separate approval.

This document decides how a real MCP server would present broker A2A tasks as
**MCP Tasks**: which process runs it, which transport it speaks, and how each
request is authenticated and authorized. It also records the re-check of the
contract v0 field names against the MCP Tasks extension specification. That
re-check found four semantic gaps. Contract v1 must fix them before any live
adapter is built.

## 1. Specification re-check (2026-11-27)

Contract v0 took its field names from the Claude Code documentation. This
re-check reads the extension specification itself:

- Extension `io.modelcontextprotocol/tasks`, revision **2026-07-28**:
  [`ext-tasks/specification/2026-07-28/tasks.md`](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md)
  and [`schema/2026-07-28/schema.ts`](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts).
  The text below was read from the raw files.
- Revision 2026-07-28 moved Tasks out of core and into this extension. The
  core changelog says the extension "replaces the blocking `tasks/result`
  method with polling via `tasks/get` and a new `tasks/update`" and removes
  `tasks/list`. The core `2025-11-25` page (`basic/utilities/tasks`, marked
  experimental) is obsolete for this work.

### 1.1 Field names: all confirmed

| Contract v0 | Extension 2026-07-28 | Result |
|---|---|---|
| `taskId`, `status`, `statusMessage`, `createdAt`, `lastUpdatedAt` | Same names. Timestamps are ISO 8601. | match |
| `ttlMs: null` | `ttlMs: number \| null` — "integer milliseconds, null for unlimited" | match |
| `pollIntervalMs` | `pollIntervalMs?: number` (optional, may change during the task's lifetime) | match |
| Status values `working`, `input_required`, `completed`, `failed`, `cancelled` | Same five values. The last three are terminal. | match |
| `inputRequests` / `tasks/update { taskId, inputResponses }` | Same names. `tasks/update` returns an empty result. | match |
| `resultType: "task"` on the `tools/call` result | `CreateTaskResult = Result & Task & { resultType: "task" }`. The task fields sit at the top level. | match |

Names that only the earlier revision used (`ttl`, `pollInterval`,
`tasks/result`, `tasks/list`, `notifications/tasks/status`, request-side
`params.task`) must not appear in the server.

### 1.2 Semantic gaps in contract v0 (contract v1 must fix these)

| # | Extension rule (quoted) | Contract v0 | Required change |
|---|---|---|---|
| G1 | "The `failed` status **MUST NOT** be used to represent non-JSON-RPC errors, such as a tool result that completed with `isError: true`." `failed` is reserved for "a JSON-RPC error during execution". | Broker `failed` maps to MCP `failed`. Broker `canceled` with approval outcome `rejected` also maps to MCP `failed`. | A task that ran and failed is a tool-level failure. It becomes `completed` with a `CallToolResult` whose `isError` is `true` and whose content carries the closed-vocabulary reason (`broker:failed`, `approval:rejected`). MCP `failed` is used only when the server's own broker call fails at the protocol level, for example when the broker rejects `SendMessage` or returns `-32603`. |
| G2 | "Each request key in `inputRequests` **MUST** be unique over the lifetime of a single task. A server **MUST NOT** reuse a key …" | One fixed key per kind (`clarification`, `operator_decision`). | Keys embed the broker checkpoint id, for example `clarification:<checkpointId>`. A key is retired as soon as its checkpoint is resolved, and a later checkpoint always gets a new key. |
| G3 | Clients "**SHOULD** fulfill the outstanding requests in `inputRequests`". In an unattended session the model is the client. | Operator-decision waits are shown as `input_required` with an `operator_decision` key, and every `tasks/update` answer is then rejected. | Operator-decision waits are shown as **`working`**, with `statusMessage` `approval:pending` or `checkpoint:awaiting_operator` and **no `inputRequests`**. Nothing invites the model to answer. A `tasks/update` aimed at such a task is acknowledged and ignored, as the extension asks for keys that are not outstanding. The server logs the reason code `operator_decision_out_of_band`. The gate itself is unchanged: no MCP path changes an approval or a checkpoint (trust boundaries, "Judge is not player"). While a task waits on an operator, `pollIntervalMs` is raised to the 30000 cap. |
| G4 | "Servers **MUST** generate [task IDs] with sufficient entropy that a third party cannot enumerate or guess them." | Any broker task id of 1..128 printable ASCII characters is exposed verbatim. REST `POST /tasks` accepts caller-chosen ids. | The server exposes only tasks that **it created itself through JSON-RPC `SendMessage`**. `SendMessage` never takes a task id from the caller, and the broker assigns `randomUUID()` (122 random bits). The facade additionally accepts only the canonical UUID form for MCP exposure. The extension has no `tasks/list`, so no other task can reach a client. The id is still never treated as a bearer token (§4.3). |

Other rules the server must follow:

- **Capability gate.** A task is returned only to a request whose
  `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` contains
  `io.modelcontextprotocol/tasks`. `tasks/get`, `tasks/update`, and
  `tasks/cancel` from a client that does not declare it are answered with
  error `-32021` (Missing Required Client Capability). `server/discover`
  advertises the extension.
- **Server-directed creation.** The client does not ask for a task. The server
  decides per request. Here the only tool is the dispatch tool (§5), and it
  always returns a task.
- **Errors.** An unknown `taskId` returns `-32602`, which **MUST** be used for
  `tasks/get`. A task the caller may not read gets the same `-32602`, so the
  error does not reveal that the task exists.
- **Cancellation is cooperative.** `tasks/cancel` acknowledges with an empty
  result and forwards a broker `CancelTask`. The MCP status moves to
  `cancelled` only after the broker state changes.
- **Completed results inline.** `tasks/get` on a `completed` task carries
  `result` (`CallToolResult`). See open question Q3.

## 2. Broker facts this design relies on

All references are at `origin/main` `098be02b`.

- **Two credentials.** One is the shared edge secret, sent in the
  `x-a2a-edge-secret` header and checked on every route except liveness,
  readiness, and the agent card (`server.ts:372`,
  `core/transport/request-security.ts:780-797`). The other is A2A HTTP
  signatures, which only cover worker routes and are off by default
  (`A2A_HTTP_SIGNATURE_WORKER_AUTH`). There are no per-role bearer tokens.
- **Requester identity is self-asserted.** It is read from the
  `x-a2a-requester-id`, `-kind`, `-role`, and `-scopes` headers
  (`request-security.ts:723-749`). `ENFORCE_REQUESTER_IDENTITY` is on by
  default.
- **Task-party check.** `assertRequesterCanSubscribeToTask`
  (`request-security.ts:931-955`) passes for the task's requester, target
  node, or assigned worker, or for a `hub`/`operator` role. JSON-RPC
  `GetTask` (`a2a/json-rpc.ts:328-344`), `ListTasks`, the per-task SSE
  stream, and `/resume` apply it.
- **REST `GET /tasks/:id` has no task-party check.** Its route context
  carries no requester identity (`http/tasks-read.ts`). Only the edge secret
  protects it.
- **Approval.** Approve and reject require a hub or operator actor
  (`core/policy-approval/broker-task-approval.ts`). With
  `A2A_APPROVER_ROLE_BINDING=enforce`, the request must also be signed by a
  key that declares the role.
- **Per-task event feed.** `GET /a2a/tasks/:id/events`
  (`core/transport/task-event-stream.ts`) applies the task-party check. The
  operator event stream (`operator-event-stream.ts`) is hub/operator only,
  debounced, and carries no per-task status, so it is not suitable for
  notifications.

## 3. Process

**Decision: a separate, thin process. It is not part of the broker.**

- A new package (working name `packages/mcp-tasks-server`) depends on the
  facade module and the broker's HTTP client types only. It never opens the
  broker state store and never imports broker core.
- It talks to the broker over the broker's existing JSON-RPC endpoint
  (`POST /a2a/jsonrpc`) using `SendMessage`, `GetTask`, and `CancelTask`, plus
  the per-task SSE stream (`/a2a/tasks/:id/events`) for optional
  notifications.
- One server process serves one MCP client session.

Why:

- It adds no new broker surface, and the broker needs no restart. A crash or
  bug in the server cannot corrupt broker state.
- Every read goes through the broker's own task-party check (§4.2). The
  server cannot widen access by accident.
- The server can be shipped and rolled back without touching broker or
  worker artifacts.

Rejected alternative: an MCP route inside the broker HTTP server. It would
put a model-facing protocol on the broker's listener and couple MCP
releases to broker releases. It would also need a new network path, which
the trust boundaries mark as approval-gated.

## 4. Transport and authentication

### 4.1 Client to server: stdio only (v1)

- The MCP client (Claude Code on an operator node) launches the server as a
  stdio subprocess, for example through `claude mcp add --scope user`. There is
  no listening socket, port, or TLS to manage, and the trust boundary is the
  local OS account.
- Streamable HTTP is **out of scope for v1**. Adding it later would need its
  own design: inbound authentication, the `Mcp-Name: <taskId>` routing
  header the extension requires, TLS, and a network-path approval.
- Worker lanes never load this server. They stay one-shot `claude -p` runs
  with `--strict-mcp-config`, as pinned by the tests from #2594.

### 4.2 Server to broker: a fixed non-operator identity

- The server reaches the broker through the same private path the operator
  node already uses for A2A rounds, for example a loopback tunnel to the T1
  broker. It does not open a new network path. One server instance talks to
  one broker. It never relays between T1 and T2.
- Credentials: the server reads the edge secret from the node's existing env
  file at start-up. It never puts it in MCP config, arguments, logs, or
  results. Docs record only the file location.
- Identity: the server sends a **fixed requester identity** from its config,
  for example the node's own principal. Its role must not be `hub` or
  `operator`, and the server **refuses to start** if the configured role is
  either one. The judge never sits in the player's tool.
- Consequence: the server can read only tasks whose requester it is, because
  every task it creates has it as requester. It cannot approve, reject, or
  clear operator checkpoints, because the broker rejects that role.

### 4.3 Authorization on every request

The extension requires that servers "**MUST** perform authentication and
authorization checks on each task-related request". In this design:

1. `tasks/get`, `tasks/update`, and `tasks/cancel` each make one broker call:
   `GetTask` or `CancelTask`, with the server's requester identity. The
   broker's task-party check is the authorization. The server keeps no
   cached copy that a later call could read without asking the broker.
2. The server keeps an in-memory set of task ids it created in this session
   and rejects any other id with `-32602` before calling the broker. This
   applies G4 and also stops a client from probing ids that the broker's
   party check would accept for other reasons.
3. The server never calls REST `GET /tasks/:id`, which has no party check
   (§2). A unit test pins this.

Known limit, inherited from the broker and not added by this design:
requester identity is self-asserted. Anyone holding the edge secret can claim
any identity. The fix belongs to the broker, for example signature binding
for read routes. It is recorded as open question Q1 and is not a blocker for
a stdio server running under the operator's own account.

## 5. Tool surface (v1)

- One tool, working name `a2a_dispatch_analysis`. It sends a source-only
  analysis request through `SendMessage` and always returns a
  `CreateTaskResult`. The tool's input is checked against the same lane and
  intent allowlist the operator's existing dispatch path uses. Patch,
  deploy, and approval intents are refused.
- No tool reads or adopts an existing broker task. Tasks created outside
  this server stay with the existing `a2a-task-poll` path.
- `statusMessage` stays closed-vocabulary, as in contract v0.

## 6. Notifications (optional in v1)

- Polling through `tasks/get` is the baseline. `pollIntervalMs` comes from
  the facade clamp (250..30000 ms, default 2000), and the server uses 30000
  while a task waits on an operator.
- Later, `subscriptions/listen` and `notifications/tasks` may be backed by the
  per-task SSE feed, one subscription per created task. The same
  capability gate applies, and `-32021` is returned to clients that do not
  declare the extension.

## 7. Delivery steps

Each step is a separate PR. Steps marked "approval" need explicit owner
approval in the current workstream.

1. **Contract v1** (code and spec): G1–G4 in `mcp-tasks-facade.ts`, with
   tests that fail on v0 behaviour. No live effect.
2. **Server package, no-live:** stdio server against an in-process fake
   broker, with conformance tests for the capability gate, the error codes,
   per-request authorization, the refusal to start with a hub or operator
   role, and the ban on REST reads.
3. **Approval — local connection:** run the server on one operator node
   against the T1 broker through the existing private path. The broker is not
   restarted and its configuration is not changed. Rollback is removing
   the MCP registration.
4. **Approval — wider use:** other nodes, notifications, and any Streamable
   HTTP transport.

## 8. Open questions

- **Q1. Self-asserted identity.** Should broker read routes, or at least
  JSON-RPC `GetTask` and `CancelTask`, accept HTTP-signature binding like the
  worker routes do? This is a broker change and needs its own issue.
- **Q2. REST `GET /tasks/:id`.** Should it get the same task-party check as
  JSON-RPC `GetTask`? This is independent of MCP. It also needs a separate
  issue.
- **Q3. Result content.** A completed task's `result` carries worker output
  into the model's context. Should the server pass the broker's projected
  artifact text as-is, or only a summary and links? Recommended: reuse the
  existing redacted projection (`projectSpecTask`) and set a size cap.
  Decide before step 2.
- **Q4. Session scope.** The created-task set is in memory, so a server
  restart forgets it. The extension suggests clients persist task ids and
  resume polling. Should the server persist its set, for example in a file
  with mode 0600 under the node state directory, so that `claude --resume`
  keeps working? Recommended: yes, keyed by the client session.

## Sources

- MCP Tasks extension 2026-07-28: `ext-tasks` repository, files
  `specification/2026-07-28/tasks.md` and `schema/2026-07-28/schema.ts`
  (read 2026-11-27).
- MCP core changelog 2026-07-28: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>.
- Broker: see the file references in §2.

# A2A compatibility drift watch

This document defines the broker's explicit drift-watch gate against the official
A2A SDK/TCK surface. It complements `docs/protocol-compatibility.md` by naming
the external compatibility references, tracking what the broker deliberately
does *not* implement, and anchoring the deterministic drift-watch test suite.

## External references (official A2A SDK/TCK)

The broker tracks compatibility drift against these official A2A project
references at the indicated pinned points. A maintainer updating the pinned
refs should also re-verify the broker's advertised profile against the refreshed
SDK/TCK surfaces.

| Reference | Repo / module | Pinned commit / tag | Checked surfaces |
|---|---|---|---|
| A2A JS SDK | `a2aproject/a2a-js` | `tck/agent/index.ts`, `src/types.ts`, `card resolver`, JSON-RPC/REST/gRPC transports, server handlers | AgentCard shape, `Task`/`Message`/`Artifact` types, JSON-RPC envelope, transport abstractions |
| A2A Python SDK | `a2aproject/a2a-python` | canonical type/proto compatibility modules, client/server route helpers | Protocol buffer types, Python-side JSON-RPC/REST routes |
| A2A Samples / ITK | `a2aproject/a2a-samples` | ITK (Interop Test Kit) / testlib, multi-language samples | Interop test harness, multi-language agent/server patterns |

> **Pinned refresh rule:** Run `npm run test:drift-watch` to verify the broker's
> advertised profile against the pinned local fixture. To refresh external refs,
> use `npm run refresh:drift-refs` (opt-in, not in default CI) and then
> re-verify.

## Supported protocol surfaces

The broker advertises a strict subset of the official A2A 1.0 protocol surface.
These surfaces are production-covered and pinned by the drift-watch test.

| Surface | Implementation | Transport | Drift-watch gate |
|---|---|---|---|
| AgentCard discovery | `GET /.well-known/agent-card.json`, `GetExtendedAgentCard` (JSON-RPC) | HTTP GET, JSON-RPC | Agent card shape, `protocolVersion`, capability flags, `defaultInputModes`/`defaultOutputModes` pinned in golden fixture |
| `SendMessage` | `src/a2a/json-rpc.ts` — creates exchange + task or appends to exchange | JSON-RPC 2.0 POST | Task projection shape, metadata keys, contextId aliasing |
| `SendStreamingMessage` | `src/server.ts` HTTP intercept + `src/a2a/json-rpc.ts` batch guard — SendMessage semantics, then SSE stream of JSON-RPC result envelopes until the task is terminal | JSON-RPC 2.0 POST → SSE | Envelope correlation by request id, batch rejection (-32600), task-event sequence reuse |
| `GetTask` / `ListTasks` | `src/a2a/json-rpc.ts` — task detail and filtered list | JSON-RPC 2.0 POST | Projection keys, list metadata summary behavior, state mapping |
| `CancelTask` | `src/a2a/json-rpc.ts` — idempotent task-scoped cancel with fan-out | JSON-RPC 2.0 POST | Cancel state mapping, terminal immutability, fan-out lineage |
| `SubscribeToTask` (SSE) | `src/a2a/json-rpc.ts` advisory + `GET /a2a/tasks/:id/events` | JSON-RPC advisory + SSE event stream | Snapshot, status-update, terminal close, heartbeat, Last-Event-ID replay |
| `GetExtendedAgentCard` | Returns broker agent card when `extendedAgentCard` capability is set; otherwise `-32007` | JSON-RPC 2.0 POST | Agent card golden fixture + capability gate |
| `a2a.peer.status` / `PeerStatus` | `src/a2a/peer-status.ts` — broker extension | JSON-RPC 2.0 POST | Extension-gated; not part of A2A 1.0 compatibility claim |
| Task projection | `src/a2a/task-projection.ts` — `A2ATaskProjection`, `A2ATaskListProjection` | Internal | Projection keys, metadata keys, state mapping, artifact ids |
| Conversation plane (#1814 C6) | `src/http/conversations-routes.ts` + `src/http/conversation-relay-routes.ts` — broker conversations, peer relay | Broker REST (`/conversations`, `/peer/conversations/*`) — NOT A2A JSON-RPC | `conversationPlane` matrix in the compatibility fixture: `a2aJsonRpcMethods` stays `[]`; non-goals stay advertised unsupported |

## Explicitly unsupported protocol surfaces

These surfaces from the official A2A SDK are intentionally **not implemented**
by the broker. The drift-watch test asserts they remain unsupported until
explicitly added to the compatibility matrix.

| Surface | Transport | Reason | Re-enable gate |
|---|---|---|---|
| **REST transport** (`a2aproject/a2a-js` REST client/server) | HTTP REST (non-JSON-RPC) | Broker uses JSON-RPC 2.0 as the sole A2A task protocol. REST endpoints exist for broker operator/internal surfaces (`/tasks`, `/exchanges`, `/workers`) but are not A2A-rest-conforming. | Add A2A REST routes matching official SDK shapes + update this document + add drift-watch coverage. |
| **gRPC transport** (`a2aproject/a2a-js` gRPC client/server, `a2aproject/a2a-python` proto modules) | gRPC | No gRPC server or client is integrated. The broker is HTTP/JSON-RPC only. | Add gRPC server with proto-defined A2A services + update this document + add drift-watch coverage. |
| **Push notification delivery** | Live push sends, retries, replay protection, receipt semantics | Config CRUD is implemented opt-in (`A2A_PUSH_NOTIFICATIONS_ENABLED`, registration only); the **default** card advertises `pushNotifications: false` and delivery is never performed. Outbox APIs are broker/operator integration surfaces, not A2A push conformance. | Implement A2A push delivery + update this document + add drift-watch coverage. |
| **A2A 0.3 compatibility mode** | Any | No 0.3-style protocol is implemented. The broker is 1.0-compatible only. | Add 0.3 envelope/method translation layer + update compatibility matrix + add drift-watch coverage. |
| **Conversation plane as A2A JSON-RPC** | JSON-RPC 2.0 | The Trusted Conversation Plane (#1814) is a broker REST + peer-relay surface, not A2A protocol methods; `SendMessage` keeps its exchange/task meaning. Its own non-goals (chat UI, autonomous debate, direct worker sockets, full replication, provider-send/polling-as-processed) stay unsupported per the spec. | Define A2A conversation methods upstream (or as an extension) + move `conversationPlane.a2aJsonRpcMethods` off `[]` + update this document + drift-watch coverage. |
| **OAuth/OIDC dynamic client auth** | HTTP discovery | Not modeled. Broker uses edge-secret and requester identity headers. | Implement official A2A auth-flow discovery + update this document. |

## AgentCard capability enforcement

The broker's advertised AgentCard capabilities are pinned by the drift-watch
golden fixture:

```typescript
// Pinned in src/fixtures/a2a-protocol-compatibility.ts
{
  capabilities: {
    streaming: true,        // SSE via SubscribeToTask
    pushNotifications: false, // default; opt-in A2A_PUSH_NOTIFICATIONS_ENABLED
                              // flips it true (config CRUD only — delivery
                              // remains EXPLICITLY unsupported)
  }
}
```

The drift-watch test fails if either flag changes without an intentional
update to this document.

## JSON-RPC method inventory

The broker implements these JSON-RPC methods. The drift-watch test verifies this
set matches the documented profile.

| Method | Status | A2A 1.0? | Notes |
|---|---|---|---|
| `SendMessage` | ✅ Implemented | Yes | With `metadata.contextId` alias |
| `SendStreamingMessage` | ✅ Implemented | Yes | Single non-batch requests only; SSE response |
| `GetTask` | ✅ Implemented | Yes | Returns `A2ATaskProjection` |
| `ListTasks` | ✅ Implemented | Yes | Broker-oriented filters |
| `CancelTask` | ✅ Implemented | Yes | Idempotent, fan-out |
| `SubscribeToTask` | ✅ Implemented | Yes | Advisory + SSE URL |
| `CreateTaskPushNotificationConfig` | ✅ Implemented | Yes | Opt-in via A2A_PUSH_NOTIFICATIONS_ENABLED |
| `GetTaskPushNotificationConfig` | ✅ Implemented | Yes | Opt-in |
| `ListTaskPushNotificationConfigs` | ✅ Implemented | Yes | Opt-in |
| `DeleteTaskPushNotificationConfig` | ✅ Implemented | Yes | Opt-in |
| `GetExtendedAgentCard` | ✅ Implemented | Yes | Broker extension |
| `a2a.peer.status` | ✅ Implemented | No (broker extension) | Extension-gated |

Methods from the official SDK NOT implemented:

- Any REST-specific task endpoints (SDK REST transport layer)
- Any gRPC-specific service methods (SDK gRPC transport layer)
- `SetTaskPushNotificationConfig` — 0.x-style method name; the 1.0 surface uses
  `CreateTaskPushNotificationConfig` (implemented opt-in, see inventory above)
- `ResubscribeToTask` — not in broker surface

## Drift-watch test suite

- `drift: conversation plane advertises support and non-support accurately (#1866)` — pins `conversationPlane.a2aJsonRpcMethods === []` (the plane is broker REST + peer relay, never A2A JSON-RPC), the non-goal list (chat UI / autonomous debate / worker-to-worker sockets / replication / polling-as-processed), the AgentCard `conversation` skill framing (`a2a.conversation-envelope.v1`, `not as A2A JSON-RPC methods`), and that no A2A transport bindings are added for it.

The drift-watch test lives at `src/a2a/drift-watch.test.ts` and enforces:

1. **Profile pinning:** The `A2A_COMPATIBILITY_PROFILE` fixture matches the
   documented profile in `docs/protocol-compatibility.md`.
2. **AgentCard capability enforcement:** `pushNotifications` remains `false`
   by default (opt-in mode flips it true for config CRUD only), `streaming`
   remains `true`.
3. **Unsupported surfaces guard:** The broker does not advertise REST, gRPC, or
   push notification transport capabilities in its agent card or public profile.
4. **Method inventory:** The implemented JSON-RPC method set matches the
   documented list above.
5. **External reference tracking:** The drift-watch fixture contains pinned
   external SDK references with a refresh timestamp.

Run with:

```bash
npm run test:drift-watch
```

This runs only the drift-watch test suite, which is deterministic and does not
make live network calls.

## Drift refresh (opt-in)

To refresh the pinned external SDK references:

```bash
npm run refresh:drift-refs
```

This is an opt-in command that may make network calls to fetch current
official SDK references. It is **not** part of default CI and must be run
explicitly by a maintainer.

After running, re-verify with `npm run test:drift-watch` and update this
document if the broker profile needs adjustment.

## Drift evidence log

| Date | Refreshed refs | Verdict | PR / commit |
|---|---|---|---|
| 2026-05-28 | Initial drift-watch gate | ✅ Compatible | This PR |

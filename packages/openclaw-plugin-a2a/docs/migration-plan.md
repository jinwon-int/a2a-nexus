# OpenClaw-core extraction plan

Tracks the work still needed to complete the extraction of the A2A
broker adapter out of OpenClaw core and into this repo. Closes out the
inventory half of plugin-a2a#1 — follow-up implementation
issues should be opened per section below.

This repo already owns:

- broker client configuration and plugin activation gate (`config.ts`)
- standalone broker HTTP client (`standalone-broker-client.ts`)
- gateway method handlers for `a2a.task.request | update | cancel | status`
  (`src/gateway-handlers.ts`)
- gateway request schemas and validators (`src/gateway-schema.ts`,
  `src/gateway-validators.ts`)
- broker <-> OpenClaw status / error / cancel-target mapping
  (`type-mapping.ts`)
- plugin entry, config migration, scope registration (`index.ts`)

The remaining OpenClaw-core ownership below is what blocks calling this
a fully independent plugin cut.

## 1. Remaining OpenClaw-core ownership

### 1.1 Delegated-task runtime inside `sessions_send`

This is the biggest outstanding piece. Today OpenClaw core still owns
the code path that runs when `sessions_send` sees a delegated task:

- deciding whether the send is a delegated broker task vs. a direct
  session message
- constructing the bridge request
  (`OpenClawA2ABrokerTaskBridgeRequest` in
  `standalone-broker-client.ts`) from whatever the caller passed
- driving the per-turn ping/pong loop (`maxPingPongTurns`,
  `announceTimeoutMs`, `roundOneReply`)
- waiting on a broker-backed `waitRunId` and resolving it when the
  broker reaches a terminal state
- emitting `a2a.task.update` / surfacing cancel through `cancelTarget`

The plugin today can *make* the broker call
(`buildBrokerCreateTaskRequestFromOpenClaw` in
`standalone-broker-client.ts`, invoked from
`createA2AGatewayBrokerClient` in `src/gateway-handlers.ts`), but the
orchestration around it — wait-run resolution, ping/pong turns, cancel
fan-out, status reconciliation — still lives in core.

Until that moves, the plugin can only serve the gateway RPC surface;
it cannot fully own the runtime behavior of a delegated send.

### 1.2 Session-layer glue in core

These are smaller pieces but live in core today and the plugin cannot
replace them without seams:

- the branch inside `sessions_send` that decides "this is a broker-backed
  delegation, route through the adapter" — currently gated by
  `shouldUseStandaloneBrokerSessionsSendAdapter` in `config.ts`, called
  from core
- wait-run registration and resolution (core owns the wait-run map today)
- correlation id / parent run id plumbing that reaches the broker
  payload today (mirrored in `readBrokerTaskPayload` in
  `src/gateway-handlers.ts`, but populated core-side)
- any heartbeat/timeout watchdog for in-flight delegations

### 1.3 Plugin SDK surface assumed by this plugin

The plugin already imports:

- `openclaw/plugin-sdk/plugin-entry` (`definePluginEntry`,
  `OpenClawPluginApi`)
- `openclaw/plugin-sdk/gateway-runtime` (`GatewayRequestHandlerOptions`)

Anything the delegated-task runtime needs from core (wait-run handle,
sessions-send interception hook, cancel dispatcher, heartbeat timer)
will have to be added to the plugin SDK before it can move. It is not
moveable "as-is" — those capabilities are not on the SDK yet.

## 2. Seams to add on the OpenClaw side

The extraction requires these new seams on the core plugin SDK. Each
should be its own follow-up issue on the core repo:

1. **Sessions-send delegation hook**
   A registered extension point that can intercept a delegated send
   before core default handling. Inputs: caller context, target ref,
   task request. Outputs: either "handled, here is the result" or
   "not handled, continue core path". The existing
   `shouldUseStandaloneBrokerSessionsSendAdapter` gate becomes the
   plugin's decision inside this hook rather than a core-side if-branch.

2. **Wait-run handle seam**
   A plugin-facing API to register a wait-run id, resolve it with a
   final status/output, and cancel it. The plugin holds the broker task
   id; core owns the wait-run map. Both sides need to agree on the
   handle.

3. **Cancel fan-out seam**
   A plugin-facing way to ask core "cancel the session run that owns
   this task" so `cancelTarget: { kind: "session_run", sessionKey, runId }`
   flows both directions: broker-initiated cancel should still be able
   to stop an OpenClaw run, and an OpenClaw cancel of the run should
   still be able to call `rawClient.cancelTask`.

4. **Heartbeat / timeout timer seam**
   The plugin needs a way to schedule a per-task watchdog without
   pulling in core timers directly. Today
   `announceTimeoutMs` / `maxPingPongTurns` are honored inside core.

5. **Plugin-owned gateway error shape**
   `src/plugin-errors.ts` deliberately keeps a tiny error surface
   (`INVALID_REQUEST | NOT_FOUND | INTERNAL`) to avoid duplicating
   core's `errorShape` graph. Once the runtime moves, confirm the
   plugin SDK exposes a richer gateway error shape so we don't have
   to re-derive one here.

## 3. Extraction order (dependency-aware)

Do **not** do these in parallel. The order matters because each step
depends on the seam added by the previous one.

1. **Land the plugin SDK seams in core** (§2.1–§2.4).
   No behavior change. Core still owns the delegated-task runtime, but
   now there is a supported extension point for the plugin to take it
   over. Ship this first so the plugin can target stable APIs.

2. **Re-home the delegation decision** (§1.2).
   Move `shouldUseStandaloneBrokerSessionsSendAdapter` usage from the
   core `sessions_send` branch into the plugin's sessions-send hook.
   Core only calls into the registered hook; it no longer knows about
   the adapter config. The plugin still leans on core for the actual
   runtime for now — this step is just the dispatch flip.

3. **Move the delegated-task runtime into the plugin** (§1.1).
   Wait-run resolution, ping/pong turns, cancel fan-out, heartbeat
   watchdog all become plugin-owned, using the seams from step 1.
   This is the biggest diff and should be its own PR on each side.

4. **Retire any now-dead core code paths.**
   Once traffic has flipped behind the plugin activation gate for at
   least one release, delete the core-side delegated-task runtime and
   any core imports of A2A task types. After this step, core has zero
   A2A-specific behavior.

5. **Standalone tests in this repo** (also listed in the README
   migration-steps section).
   Without step 3 done, the meaningful tests still have to run inside
   the OpenClaw monorepo. After step 3, plugin-owned regression
   coverage can live here and run against a sibling `a2a-broker`
   checkout. The regression matrix
   (`docs/regression-matrix.md`) is the scope-of-coverage doc for
   that work.

6. **Publish + compatibility matrix.**
   Only meaningful once steps 1–5 are in. Pin a supported
   `a2a-broker` version range and a supported `openclaw` plugin SDK
   version range.

## 4. Broker contract fields that must stay aligned

These are the touchpoints where plugin and broker share a wire shape.
Any change on either side needs a coordinated change on the other,
independent of where the runtime lives. Keep this list in sync with
`standalone-broker-client.ts` when fields change.

### 4.1 Party refs

`A2ABrokerPartyRef` — `{ id, kind?, role? }` with:

- `kind` ∈ `session | node | user | service`
- `role` ∈ `hub | live-trader | researcher | analyst | operator`

Plugin and broker must agree on this closed set. Adding a value is a
broker change that the plugin schema must follow the same release.

### 4.2 Task status vocabulary

`A2ABrokerTaskStatus` ∈
`queued | claimed | running | succeeded | failed | canceled`.

Mapping to OpenClaw `A2AExecutionStatus` lives in
`type-mapping.ts::mapBrokerStatusToExecutionStatus`. If the broker
introduces a new status (e.g. an explicit `timed_out`), the mapping
must be updated *before* the broker starts emitting it.

### 4.3 Task intent vocabulary

`A2ABrokerTaskIntent` ∈
`chat | analyze | backfill | propose_patch | propose_params |
validate_change | apply_local_change | promote_to_live | rollback_live`.

Gateway `a2a.task.request.task.intent` is a separate, smaller union
(`delegate | ask | handoff | notify`) — the plugin gateway schema
and the broker request schema are deliberately **not** the same enum.
Do not collapse them. The translation happens in
`buildBrokerCreateTaskRequestFromOpenClaw`.

### 4.4 SSE event / reason vocabularies

`task-snapshot` / `task-status-update` with reason ∈
`created | claimed | started | succeeded | failed | canceled |
reassigned | requeued | dead_lettered` (status-update) or
`snapshot` (snapshot).

These underpin the regression scenarios in
`docs/regression-matrix.md` (requeue, dead-letter). Plugin code that
subscribes must stay exhaustive over this union.

### 4.5 Error envelope

Broker error body shape is `{ error: { code?, message?, details? } }`;
`standalone-broker-client.ts::buildClientError` depends on it.
`A2ABrokerClientError.status` plus `code` are what the plugin uses to
shape gateway errors. Breaking this shape on the broker side is a
plugin-visible break.

### 4.6 Edge auth

The `x-a2a-edge-secret` header and the `x-a2a-requester-*` family
(`id`, `kind`, `role`) are set by the plugin and interpreted by the
broker. Renaming or retiring any of them must be coordinated. Auth
failures map to the `auth failure` row in
`docs/regression-matrix.md`.

### 4.7 Payload carry-through fields

`readBrokerTaskPayload` in `src/gateway-handlers.ts` reads back these
payload keys that the plugin wrote in via
`buildBrokerCreateTaskRequestFromOpenClaw`:

- `requesterSessionKey`
- `requesterChannel`
- `targetSessionKey`
- `targetDisplayKey`
- `correlationId`
- `parentRunId`

The broker must preserve `payload` verbatim on read. If the broker
starts normalizing payload keys, the plugin loses the round-trip.

## 5. Suggested follow-up issues

Open these once the plan above is agreed:

- **core**: add sessions-send delegation hook to plugin SDK (§2.1)
- **core**: add wait-run handle seam (§2.2)
- **core**: add cancel fan-out seam (§2.3)
- **core**: add heartbeat/timeout timer seam (§2.4)
- **plugin**: move delegation decision behind the new sessions-send
  hook (§3 step 2)
- **plugin**: move delegated-task runtime out of core (§3 step 3)
- **plugin**: add standalone tests per `docs/regression-matrix.md`
- **plugin**: publish compatibility matrix with `a2a-broker`

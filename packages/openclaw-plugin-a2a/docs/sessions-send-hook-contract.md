# Sessions-send hook contract for delegated A2A dispatch

Closes the planning half of plugin-a2a#7.

This doc narrows the plugin-owned side of the `sessions_send` interception flow so the eventual core seam can land as a small, reviewable change instead of another round of design work.

## Goal

Move the delegation decision out of OpenClaw core and behind a plugin-owned hook, without changing the broker wire contract or the existing delegated-task runtime semantics in the same step.

Phase split:

1. **Dispatch flip only**
   - core asks registered plugins whether they want to intercept this send
   - this plugin decides yes/no
   - core still owns the wait-run / ping-pong / timeout runtime for now
2. **Runtime move later**
   - plugin owns wait-run resolution, cancel fan-out, timeout watchdog, and broker status reconciliation

Issue #7 is about phase 1 being unambiguous.

## Hook inputs the plugin expects

The hook should receive enough information to decide between direct send and delegated send without importing any A2A-specific core code.

```ts
interface SessionsSendHookContext {
  sessionKey: string;
  target: {
    sessionKey?: string;
    displayKey?: string;
  };
  message: string;
  task?: {
    intent?: string;
    instructions?: string;
    constraints?: {
      timeoutSeconds?: number;
      maxPingPongTurns?: number;
    };
    runtime?: {
      waitRunId?: string;
      roundOneReply?: string;
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
  rawParams: unknown;
}
```

Required decision-time fields are the subset already consumed by `buildBrokerCreateTaskRequestFromOpenClaw`:

- target `sessionKey` / `displayKey`
- task intent and instructions
- requester session/channel
- `waitRunId`
- `roundOneReply`
- `announceTimeoutMs`
- `maxPingPongTurns`
- `cancelTarget`
- `correlationId`
- `parentRunId`

If core cannot provide these fields yet, the seam is still too small.

## Hook outputs the plugin should return

The hook should be tri-state, not boolean-only.

```ts
type SessionsSendHookResult =
  | { handled: false; reason?: string }
  | {
      handled: true;
      mode: "delegated";
      dispatch: {
        kind: "a2a-broker";
        taskId: string;
        waitRunId?: string;
        cancelTarget?: {
          kind?: string;
          sessionKey?: string;
          runId?: string;
        };
      };
    }
  | {
      handled: true;
      mode: "direct";
      result: unknown;
    };
```

For the phase-1 dispatch flip, this plugin only needs two real outcomes:

- `handled: false` → core continues normal direct-send path
- `handled: true, mode: "delegated"` → core continues existing delegated runtime, but now using plugin-produced dispatch data

That keeps the diff narrow.

## What stays plugin-owned

These decisions should live in the plugin, not in core:

1. **Activation gate**
   - `resolveA2ABrokerAdapterPluginConfig`
   - `shouldUseStandaloneBrokerSessionsSendAdapter`
   - whether plugin allow/deny lists and `entries.a2a-broker-adapter.*` permit interception

2. **Broker request translation**
   - `buildBrokerCreateTaskRequestFromOpenClaw`
   - mapping OpenClaw delegated-send shape to broker task intent / payload / requester headers

3. **Broker contract validation**
   - payload carry-through keys
   - requester / edge-secret headers
   - task-status / error mapping owned in this repo

Core should not retain any A2A-specific `if adapter enabled then ...` branch after the dispatch flip.

## What stays core-owned in phase 1

To keep the first flip reviewable, these remain core-owned until the later runtime move:

- wait-run registration and terminal resolution
- ping-pong loop semantics
- timeout / watchdog scheduling
- cancel fan-out to session runs
- final user-visible `sessions_send` response shape

## Migration checklist for the dispatch flip

### Core seam prerequisites

- [ ] plugin SDK exposes a `sessions_send` interception hook
- [ ] hook receives the fields listed in "Hook inputs"
- [ ] hook may return delegated dispatch metadata without taking over runtime ownership
- [ ] core can continue its existing delegated wait-run path from plugin-produced dispatch data

### Plugin changes for phase 1

- [ ] replace direct core use of `shouldUseStandaloneBrokerSessionsSendAdapter` with plugin hook registration
- [ ] call `buildBrokerCreateTaskRequestFromOpenClaw` from the hook-owned path
- [ ] return delegated dispatch metadata with broker task id and wait-run id
- [ ] keep all broker-specific config checks in this repo
- [ ] document any remaining core-owned runtime behaviors as explicitly temporary

### Deferred to phase 2

- [ ] plugin-owned wait-run handle usage
- [ ] plugin-owned timeout watchdog
- [ ] plugin-owned cancel fan-out
- [ ] standalone regression automation for full delegated-send runtime in this repo

## Verification plan

### A. Direct send remains direct

Setup: plugin installed but disabled, or enabled without `baseUrl`.

Pass:
- hook returns `handled: false`
- core direct `sessions_send` path runs unchanged
- no broker task is created

### B. Delegated send flips through plugin decision

Setup: plugin enabled, `baseUrl` present, delegated task intent present.

Pass:
- hook returns `handled: true, mode: "delegated"`
- broker task is created through plugin request translation
- core runtime continues to wait on the returned task/wait-run pair
- final response shape matches pre-flip behavior

### C. Non-delegated `sessions_send` traffic is unaffected

Setup: normal chat/direct send, same plugin config as B.

Pass:
- hook either declines or is not invoked for non-delegated shape
- no change in routing or response semantics

### D. Cancel path metadata survives the flip

Setup: delegated send with `cancelTarget` and `parentRunId`.

Pass:
- broker payload preserves `cancelTarget`, `correlationId`, `parentRunId`
- later cancel still reaches the same session-run identity core expects

## Remote node-id resolution contract

Tracks `plugin-a2a#80`.

When a `sessions_send` invocation targets a *remote* A2A node-id (e.g. `node-remote`) rather than a locally-visible session key, the plugin must be able to:

1. detect the remote target before any local-session visibility check fails, and
2. preserve the node-id through to broker task creation so the receiving node is correctly addressed.

The plugin-side surface is split across two additive modules to keep the heuristic and the dispatch wiring testable in isolation:

- `src/remote-node-resolver.ts` exports `resolveRemoteNodeId(key, options?)` which returns either `{ remote: false }` or `{ remote: true; nodeId; delegatable }`. The default heuristic treats any key without the agent prefix separator (`:`) as a candidate remote node-id; callers can pass `knownLocalAgents` to suppress false positives for bare local agent names.
- `src/remote-node-handoff-adapter.ts` exports `createRemoteNodeHandoffAdapter(config, { innerHook, resolverOptions? })` which wraps an existing `sessions_send` hook with remote awareness.

Adapter behavior (encoded in `test/remote-node-handoff-adapter.test.mjs`):

| Target shape | Adapter active? | Outcome |
|---|---|---|
| Remote node-id (via `displayKey` or `sessionKey`) | yes | inner hook is invoked, broker task created with `targetNodeId` preserved, result decorated with `remote: { nodeId, source }` |
| Remote node-id | no | adapter returns `{ handled: false, reason: "remote node-id requires A2A adapter", remote: { nodeId, source } }` without invoking the inner hook |
| Local session key (`agent:main:...`) | either | adapter is a no-op pass-through to the inner hook |
| Mixed: remote `displayKey` + local `sessionKey` | yes | classified remote (source: `displayKey`); broker target is the remote node-id while broker payload still carries the local `targetSessionKey` |
| Additional unknown fields in `event.rawParams` / inner dispatch | either | preserved verbatim — the adapter does not validate or strip additive metadata |

For convenience, `src/sessions-send-hook.ts` also exports a wrapped factory `createA2ASessionsSendHookWithRemoteResolution(config, runtime?, deps?)` which builds the canonical hook and returns it pre-wrapped with the handoff adapter. Existing callers of `createA2ASessionsSendHook` are unchanged.

### Required core seam

The above is plugin-side only and cannot, on its own, fix the user-reported failure where `sessions_send` targeting a remote node-id is rejected by core's `handleSessionSend` before any plugin hook runs.

What core needs:

- **A pre-visibility plugin hook** invoked before `loadSessionEntry(key)`. If the registered plugin returns `{ handled: true }` (delegated or direct) the core must not perform the local-session existence check on `key`. If it returns `{ handled: false }` the core proceeds with its existing visibility behavior.
- The hook contract (event/result shapes) is identical to the phase-1 `sessions_send` hook documented above; the only change is the *call site* — moving it earlier in the request pipeline so a remote node-id never reaches `loadSessionEntry`.

This pairing leaves the dispatch decision plugin-owned (this repo) while the missing piece — invoking the hook before local-session visibility hard-fails — sits squarely in core.

### Cross-repo integration links

- core P0: [jinwon-int/openclaw#50](https://github.com/jinwon-int/openclaw/issues/50) — pre-visibility plugin hook seam for `sessions_send`
- core P0: [jinwon-int/openclaw#51](https://github.com/jinwon-int/openclaw/issues/51) — remote node-id handoff in `handleSessionSend`

Until those land, `createA2ASessionsSendHookWithRemoteResolution` is a no-op for the current `sessions_send` user path (the hook never fires for remote targets) but is fully exercised by the `a2a.task.request` gateway and by direct unit tests.

## Review boundary

If a PR for #7 changes any of the following, it is too large for the dispatch-flip step and should be split:

- wait-run map implementation
- timeout scheduler implementation
- ping-pong turn semantics
- broker status reconciliation behavior
- user-facing `sessions_send` response contract

Those belong to the later runtime-move issue, not this dispatch decision issue.

# Runtime Wake Adapter Contract

Issue: `jinwon-int/plugin-a2a#39`

The Wake Layer must stay **default-off / opt-in**. This contract only defines the
adapter boundary used after an explicit Wake-on-Task feature gate decides a wake
should be attempted.

## Goal

Hide runtime-specific launch/resume/message-append behavior behind a narrow port
so gateway and broker code do not need Codex/Claude/PTX/Termux-specific branches.

## Adapter interface

```ts
type A2ARuntimeWakeAdapter = {
  readonly runtime: "openclaw-session" | "worker-run" | "in-process-queue";
  wake(request: A2AWakeRequest): Promise<A2AWakeDispatch> | A2AWakeDispatch;
  failures(): A2AWakeFailureRecord[];
};
```

`A2AWakeRequest` carries:

- `taskId` — broker task identifier.
- `targetSessionKey` — OpenClaw session that should receive/resume work.
- `message` — task message or synthesized wake instruction.
- optional `correlationId`, `targetNodeId`, `runtimeHint`, `createdAt`.

`A2AWakeDispatch` returns:

- `queued` when a wake is accepted but not yet launched.
- `coalesced` when another wake for the same active target session already
  exists.
- `dispatched` for future adapters that synchronously launch/resume a runtime.
- `visibleFailure` when the attempt could not be safely accepted.

## Active-session coalescing

The low-resource adapter coalesces by `targetSessionKey`:

1. first task creates one queue entry and `wakeId`;
2. later tasks for the same active target session reuse the same `wakeId`;
3. `taskIds` preserves all broker task ids; the latest message becomes the
   visible queued message;
4. no extra daemon or process is spawned by the in-process adapter.

This is the Android/Termux-safe fallback and the recommended behavior for nodes
where one extra worker process is too expensive.

## Runtime unavailable path

A runtime adapter must never fail silently. If the runtime is missing, disabled,
or temporarily unavailable, it records an `A2AWakeFailureRecord` with:

- `visible: true`
- `reason: "runtime_unavailable"`
- `taskId` and `targetSessionKey` when available
- timestamp and human-readable message

The caller can project these records into broker diagnostics or GitHub/status
reports without scraping logs.

## Low-resource / Termux review

For mobileAlpha/Android Termux:

- default to `in-process-queue` rather than an extra daemon;
- avoid background polling loops;
- coalesce repeated wakes for the same session;
- keep wake execution behind explicit opt-in config;
- expose failures as data so gateway restarts and memory pressure do not hide
  missed wakes.

## Non-goals for Phase 6b

- No live wake behavior is enabled by default.
- No workerGamma regression-lock behavior changes.
- No broker Phase 7 event stream or Phase 8 peer-status RPC implementation.

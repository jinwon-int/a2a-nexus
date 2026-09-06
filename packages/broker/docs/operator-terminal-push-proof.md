# Operator Terminal Push Proof Harness

This broker-local proof exercises the terminal event outbox and compact SSE projection without calling Telegram directly. Operator Telegram and main-session delivery remain owned by `<notifier-host>/OpenClaw plugin-notifier`.

## Covered terminal envelopes

The CI test `TerminalTaskEventOutbox proves operator terminal push envelopes without direct Telegram delivery` creates deterministic fake notifier envelopes for:

- `succeeded` task completion
- `failed` task completion
- PR opened / Done evidence task with `prUrl` and `doneUrl`

The proof also asserts a negative: an approval-gated task (`status: "blocked"`)
produces **no** terminal record on either surface. `blocked` is the
pre-execution approval gate, not a completion result, so neither the durable
outbox nor the compact SSE projection announces it as terminal (#2056). A worker
that reports a Block outcome fails the task, so real Block evidence still
arrives as a `failed` terminal record carrying `blockUrl`.

Expected fake envelope shape:

```json
{
  "envelopeVersion": 1,
  "delivery": "operator-terminal-push-proof",
  "transportOwner": "<notifier-host>/OpenClaw plugin-notifier",
  "brokerTransport": "webhook-or-sse",
  "cursor": "terminal:<task-id>:<status>:<completed-or-updated-at>",
  "body": {
    "taskId": "proof-pr-opened",
    "status": "succeeded",
    "worker": "worker-1",
    "repo": "jinwon-int/a2a-broker",
    "issue": 229,
    "prUrl": "https://github.com/jinwon-int/a2a-broker/pull/230",
    "doneUrl": "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-done",
    "testSummary": "PR opened and Done evidence posted from [path]",
    "createdAt": "<iso>",
    "updatedAt": "<iso>",
    "completedAt": "<iso>"
  }
}
```

## Replay and duplicate behavior

- The outbox cursor is the stable `cursor`/event id.
- `subscribe({ afterId })` returns only events after that cursor.
- Repeated terminal updates for already-terminal tasks do not enqueue duplicate outbox events.

## Redaction guarantees checked by the proof

The proof asserts that serialized webhook/SSE payloads do not contain direct Telegram routing, raw log keys, raw transcript keys, token-like values, password values, local credential paths, or private session paths.

## Run after Docker broker deploy

From the deployed broker checkout/container:

```sh
npm test -- --test-name-pattern "operator terminal push envelopes"
```

For the full CI-safe gate, run:

```sh
npm test
```

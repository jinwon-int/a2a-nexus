# Standalone worker compatibility review

This review records a second, non-OpenClaw worker lane for A2A Nexus. It is documentation evidence only: it does not register a worker, start a broker, send provider messages, or mutate terminal ACK state.

## Scope reviewed

- `contracts/a2a/task-lifecycle.md` for shared task and terminal states.
- `contracts/a2a/worker-registration.md` for the public-safe worker registration fields.
- `contracts/a2a/terminal-semantics.md` for Done / PR / Block evidence boundaries.
- `examples/canonical-demo-task.json` for the existing public-safe task envelope shape.
- `docs/quickstart.md` for the local-only dummy or echo worker guidance.
- `docs/validation/standalone-worker-terminal-evidence.md` for the second worker evidence mapping.

Production broker, plugin, runner, database, provider, terminal-outbox, and visibility paths were intentionally out of scope.

## Compatibility finding

A2A Nexus is compatible with a standalone worker that only implements the broker worker contract. OpenClaw is the first/reference operator integration, but the worker side does not require an OpenClaw runtime when these conditions hold:

1. The worker has a stable public-safe `workerName`, coarse `capabilities`, and a `policyVersion` as described by the worker registration contract.
2. The worker can claim a queued task, mark it running, and finish with exactly one terminal result: `done`, `pr`, or `blocked`.
3. Terminal evidence is redacted and bounded to summaries, changed files, validation commands, PR URLs, or Block reasons.
4. Provider-send acceptance, notification delivery, and terminal-outbox ACK mutation are not treated as Done evidence.
5. The worker uses local loopback or placeholder configuration for demos; it does not depend on private hosts, provider IDs, raw session logs, or operator-specific paths.

The example card in `examples/workers/standalone-http-worker/worker-card.json` follows this lane. It models a generic HTTP worker with documentation and repository-inspection capabilities and no OpenClaw-specific fields.

For the `a2a-vnext-contract-smoke-crossbroker-20260510` round, `fixtures/contract/worker-registration-capabilities.json` adds `worker-jingun-second-worker` as a public-safe Team2/Gwakga compatibility proof. The fixture binds the worker to issue #152, declares only coarse capabilities, and records that validation is local conformance only: no private topology, live provider send, or terminal ack mutation is required.

## Second reference worker shape

The standalone lane is intentionally smaller than an operator integration. A compatible worker only needs to speak the broker worker contract: advertise a public-safe card, claim a queued task, report running state, and close with one terminal result. Its terminal evidence can be a redacted Done summary, a PR URL with validation, or a Block reason. It must not rely on OpenClaw bootstrap files, Gateway configuration, provider delivery receipts, or terminal-outbox ACK mutation to prove completion.

## Non-coupling checks

| Check | Result | Evidence |
|---|---|---|
| OpenClaw runtime required for worker registration | No | Worker registration only requires public-safe identity, capabilities, policy version, liveness, and task reference fields. |
| Private infrastructure required for local review | No | Example values use loopback URLs or placeholders only. |
| Provider or Telegram delivery required for terminal state | No | Terminal semantics require Done / PR / Block evidence, not provider acceptance. |
| Terminal ACK bypass allowed | No | Workers must not mutate terminal ACK state as readiness evidence, including while upstream OpenClaw receipt work remains unresolved. |
| Production service interaction required | No | This review is read-only documentation and example fixture work. |

## Safe validation path

A reviewer can validate this compatibility lane without private infrastructure:

```bash
npm run check
```

The command exercises repository layout, package metadata, public-readiness scanning, and compatibility-baseline checks. A future runnable standalone worker should add its own local-only smoke test under `examples/workers/**` before expanding public compatibility claims.

# Implementation-lane readiness policy

Issue: #1597

`canPatchWorkspace` means that a worker may edit a workspace. It is not proof
that the worker has a usable implementation runtime, provider route, model
tier, or current canary. Implementation scheduling therefore fails closed on
the separate `implementationCapability` profile.

## Registration and heartbeat profile

Workers refresh the profile through the existing registration and heartbeat
`capabilities` payload:

```json
{
  "implementationCapability": {
    "capable": true,
    "runtime": "claude-native",
    "providerId": "anthropic",
    "modelTier": "claude-implementation",
    "availability": "canary_passed",
    "lastVerifiedAt": "2026-07-22T00:00:00.000Z",
    "evidenceId": "worker-canary-20260722"
  }
}
```

Workers declare the profile through either the `WORKER_CAPABILITIES_JSON` blob
or discrete environment variables, whichever the node already uses:

```bash
WORKER_IMPLEMENTATION_CAPABLE=true
WORKER_IMPLEMENTATION_RUNTIME=claude-native
WORKER_IMPLEMENTATION_PROVIDER_ID=anthropic
WORKER_IMPLEMENTATION_MODEL_TIER=claude-sonnet-5
WORKER_IMPLEMENTATION_AVAILABILITY=canary_passed
WORKER_IMPLEMENTATION_LAST_VERIFIED_AT=2026-07-26T00:00:00.000Z
WORKER_IMPLEMENTATION_EVIDENCE_ID=worker-canary-20260726
```

The discrete variables take precedence, so readiness can be granted or revoked
without rewriting a capabilities document. Each accepts an `A2A_`-prefixed
alias. Declaring nothing leaves the profile absent, which is the legacy path:
the worker keeps registering and stays ineligible for implementation work.

Values are published verbatim; the broker owns the single normalization
boundary. Set `availability` to `canary_passed` only after a real canary — a
worker that merely has the runtime installed should publish `configured`, which
the readiness rule correctly rejects.

Allowed runtimes are `claude-native`, `codex-native`, `provider-native`, and
`unknown`. Provider and model-tier identifiers are normalized as secret-safe
lowercase IDs. Tokens, credential paths, OAuth payloads, and raw provider
responses are never accepted as capability evidence.

A worker is implementation-ready only when all of these are true:

1. `capable` is `true`;
2. runtime, provider, and model tier are recorded;
3. `availability` is `canary_passed`;
4. the profile matches any runtime/provider/model-tier pin on the task; and
5. the normal role, task-type, workspace, capacity, and environment checks pass.

Missing profiles remain valid for legacy registration and analysis lanes, but
they are ineligible for `propose_patch`, `propose_params`, and
`apply_local_change`. This is the additive v0-to-v1 compatibility path: old
workers continue heartbeating, while implementation assignment stays blocked
until they publish verified v1 readiness.

## Broker policy and redundancy

The scheduler dry-run accepts an optional implementation policy:

```json
{
  "requiredRuntime": "claude-native",
  "requiredProviderId": "anthropic",
  "requiredModelTier": "claude-implementation",
  "minimumReadyWorkers": 2
}
```

`minimumReadyWorkers` defaults to `1`. Set it to `2` when the lane must not
depend on one implementation worker. If the eligible cohort is below the
minimum, the scheduler returns `selectedWorkerId: null`; it does not nominate a
failing worker for manual dispatch. Setting the minimum to `1` is the explicit
way to accept a temporarily single-worker lane.

The dry-run result and Markdown renderer include a per-worker runtime,
provider, model-tier, availability, readiness, and eligibility matrix. They
also mark `singlePointOfFailure: true` whenever exactly one worker is eligible,
even when a temporary minimum-of-one policy permits dispatch.

## Read-only fleet report

The existing readiness reporter consumes sanitized broker capacity and host
audit snapshots using the same fields:

```bash
node scripts/a2a-worker-readiness-matrix.mjs \
  --capacity capacity.json \
  --audit audit.json \
  --required-runtime claude-native \
  --required-provider anthropic \
  --required-model-tier claude-implementation \
  --minimum-ready-workers 2
```

The command is source-only and read-only. It performs no SSH, registration,
heartbeat, dispatch, claim, GitHub write, deploy, restart, send, ACK/replay, or
secret movement.

## Enforcement at claim time

The readiness rule is also enforced on the live claim path, not only in the
scheduler dry run. Set `requireImplementationCapability: true` on a broker
policy rule (see [broker-policy](../contracts/a2a/broker-policy.md)) and
`claimTask` re-evaluates the claiming worker with the same
`evaluateImplementationReadiness` function the dry run uses.

Claim-time enforcement covers **clauses 1 to 3 only** — `capable`, a recorded
runtime/provider/model tier, and `canary_passed`. It deliberately does not
evaluate the rest:

- **Clause 4** (runtime/provider/model-tier pins) is a scheduler concern. Pins
  live on the dry-run task profile, not on the task record, so a claim has
  nothing to match against. A worker the dry run reports as ineligible under a
  pin can therefore still claim the task. Use the dry run, not the claim gate,
  to enforce a pin.
- **Clause 5** (role, task type, workspace, capacity, environment) is already
  covered by the existing admission gates on the claim path.
- **Worker plane / heartbeat recency** is excluded on purpose. A claim is proof
  of liveness — the worker just made an authenticated request — while
  `workerPlane` is derived only from heartbeat recency. Judging it here would
  deny a healthy worker that missed a few heartbeats for a reason unrelated to
  capability. Liveness gating belongs to the scheduler, which chooses among
  workers that are not currently talking to the broker.

The gate is opt-in and follows the standard `warn` → `enforce` promotion:

| Mode | Unready worker claims an implementation task |
|---|---|
| no policy document | claim proceeds (legacy behaviour) |
| rule omits the field | claim proceeds |
| `warn` | claim proceeds; `task.policy_warned` audit records the blockers |
| `enforce` | claim rejected `policy_denied`; `task.policy_denied` audit |

Enforcement is claim-time rather than create-time because a task may be created
before a capable worker exists, and because the claiming worker's anonymous
class can differ from the create-time target's.

**A denied task is not automatically rescued.** The task stays `queued`, but
`assertTaskWorker` requires the claimer to be the assigned worker, and the
broker exposes no reassignment, so no other worker can pick it up. Recovery is
an operator action: either bring the assigned worker to verified readiness and
let it re-claim, or cancel the task and recreate it against a ready worker.

Because a denied claim maps to HTTP 403, the worker treats it as skip-and-retry
and re-claims every poll interval. The claim-time policy audit is therefore
de-duplicated per `(task, rule, action)`, so a stuck task records one
`task.policy_denied` event rather than one per retry. This matches the
task-deduplicated hit count the warn-mode observation report already uses.

## Visibility

Implementation provider/model readiness is broker-local. Team/private worker
capability cards may expose it only with the existing
`exposeProviderCapabilities` opt-in. Public capability cards always omit it,
and validation rejects manual public exposure.

# Broker adapter guide

This guide describes a source-only external-consumer boundary for
`a2a-policy-referee` `0.1.0`. The package evaluates policy and returns a
decision. It never applies policy: it does not create or claim tasks, reject a
request, change task state, route approval, or emit an audit. Every such action
belongs to the caller.

The replayable example is deliberately offline and imports only the built
package public root:

```js
import {
  evaluatePolicyRefereeCli,
  parsePolicyRefereePolicyDocument,
  parsePolicyRefereeTaskEnvelope,
  parsePolicyRefereeWorkerEnvelope,
} from "a2a-policy-referee";
```

It has no broker/runtime dependency, listener, service mode, network access, or
live integration:

```sh
npm run build -w packages/policy-referee
npm run examples:replay -w packages/policy-referee
```

The five input cases are closed in
[`../examples/broker-adapter-cases.json`](../examples/broker-adapter-cases.json),
and the executable mapping is
[`../examples/broker-adapter-replay.mjs`](../examples/broker-adapter-replay.mjs).

## Create and claim mapping

Treat the package envelopes as an anti-corruption boundary. Construct fresh
objects and pass every one through the public strict parser before evaluation.
Do not cast broker objects directly to package types.

| Caller value | Policy-referee value |
|---|---|
| Loaded untrusted policy JSON | `parsePolicyRefereePolicyDocument(rawPolicy)` |
| Create admission | task `evaluationPoint: "create"` |
| Claim admission | task `evaluationPoint: "claim"` |
| Broker task intent | task `intent` canonical token |
| Broker task mode, when present | task `mode` canonical token |
| Anonymous target class at create | worker `workerClass` |
| Anonymous claiming-worker class at claim | worker `workerClass` |
| Caller-verified claim readiness, when relevant | worker `implementation` booleans |

At create, map the anonymous class of the target lane and explicitly use
`evaluationPoint: "create"`. The existing evaluator then preserves the
create-time opt-out for an implementation-capability gate.

At claim, map the anonymous class of the claiming worker and explicitly use
`evaluationPoint: "claim"`. If implementation capability is relevant, the
caller computes readiness and supplies only
`isImplementationIntent` and `ready`. Omitting readiness at a claim-time gate
fails closed through the existing evaluator.

## Lazy `tasksToday` contract

`tasksToday` is the number of tasks already created for the anonymous class in
the current UTC day. Supply it only when the matched evaluator rule declares
`maxTasksPerDay`. The package converts the number to the existing evaluator's
lazy counter: it requires the number if the evaluator invokes the counter and
rejects the number if the evaluator does not invoke it.

An adapter must not inspect or reimplement rule precedence to predict counter
use. A caller that wants true lazy storage access can first evaluate without
`tasksToday`; only the stable `PolicyRefereeInputError` tuple
`required_field` / `task` / `$.tasksToday` may trigger one anonymous-class UTC
count and a retry with the parsed numeric snapshot. All other errors fail
closed. Cache or transaction semantics for that count remain caller-owned.

## Anonymous worker-class boundary

The worker parser accepts only `mobile`, `vps`, `source-only`, or
`unclassified`. Policy rules may additionally use `*`. Derive that anonymous
class before calling this package and never pass a worker name, account,
provider, host, model, path, URL, header, credential, token, payload, or other
identity/transport value. The package neither needs nor accepts a broker worker
object.

## Caller-owned action projection

The returned decision is evidence, not an applied state transition. A caller
must choose and test its own projection. The bounded example uses this closed
mapping:

| Valid returned decision | Example caller action |
|---|---|
| any mode + `allow` | `proceed` |
| any mode + `require_approval` | `route_approval` |
| warn + `deny` | `observe_proceed` |
| enforce + `deny` | `reject` |

Warn mode relaxes `deny` only: it observes that decision but proceeds. Enforce
mode rejects a deny. In both modes, a `requireApproval` rule's
`require_approval` decision remains caller-routed and blocking: the caller must
enter its existing blocked/approval flow and keep the task non-runnable until
that separate flow succeeds. The `route_approval` token never grants approval,
and the package does not know how to block, route, or approve a task.

## Audit and failure ownership

The caller owns audit schema, persistence, retention, access control, and any
link to caller-side identities. Audit only stable parsed decision fields; do
not treat the example replay output as a production audit format. Never attach
raw policy/task/worker documents, evaluator reasons, credentials, URLs, or
transport payloads merely because an evaluation occurred.

Parser errors, evaluator input errors, unsupported versions, unreadable input,
unexpected decisions, and adapter exceptions are not allow decisions. Fail
closed before applying a caller action. The example buffers all cases, emits
nothing on stdout after any invalid case, writes one fixed
`a2a.policy-referee.broker-example-error.v1` token to stderr, and exits `64`.
It never reflects paths, raw documents, evaluator reasons, identities, URLs,
credentials, or arbitrary diagnostic prose.

## Version and change control

Pin the exact package version (`a2a-policy-referee@0.1.0`) and lockfile or
artifact integrity. Do not use a range, `latest`, or an unpinned branch. Pin
the task, worker, policy, example-manifest, and expected-output schema versions
as well. Review and replay the closed five-case examples before accepting a
new package or schema version. The package remains private; this guide is
extraction evidence, not publication, repository-creation, or live-enforcement
approval.

# a2a-policy-referee

Private monorepo package for deterministic, broker-independent policy
validation and offline task-policy evaluation (#1601 P1; extraction-readiness
slice #1480).

The broker and this CLI use the same package-owned policy functions:
`validateBrokerPolicyDocument` validates policy documents and
`evaluateTaskPolicy` makes every policy decision. The CLI adds only strict
public-input validation and a non-reflecting decision projection. It does not
import broker runtime modules or maintain a second evaluator.

- Policy contract: [`contracts/a2a/broker-policy.md`](../../contracts/a2a/broker-policy.md)
- Golden cases: [`fixtures/golden/manifest.json`](fixtures/golden/manifest.json)
- Negative cases: [`fixtures/negative/manifest.json`](fixtures/negative/manifest.json)

The package remains named `a2a-policy-referee`, remains `"private": true`, and
remains in `a2a-nexus`. This slice is not standalone-repository extraction or
package-publication approval.

## Build and usage

Node.js 22.5 or newer is required.

```sh
npm run build -w packages/policy-referee
a2a-policy-referee check POLICY.json TASK.json WORKER.json
```

In a monorepo checkout, the built entry can also be invoked directly:

```sh
node packages/policy-referee/dist/cli.js check POLICY.json TASK.json WORKER.json
```

`check` takes exactly three UTF-8 JSON files. The policy file is capped at
65,536 bytes; task and worker files are each capped at 4,096 bytes. Non-files,
unreadable files, oversized files, malformed UTF-8, and malformed JSON fail
closed.

## Input contracts

All three top-level values and every nested object must be ordinary JSON
objects. Unknown fields, inherited/prototype-polluted objects, accessors,
non-plain objects, sparse/custom arrays, cycles, excessive nesting, and
unsupported versions are rejected.

### Policy

`POLICY.json` is the closed `a2a.broker.policy.v1` document from the broker
policy contract. The CLI calls `validateBrokerPolicyDocument`; it does not
duplicate that validator. For the public-safe CLI profile, every
`allowIntents` and `denyModes` item must additionally be a 1–64 character
canonical token matching:

```text
[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*
```

This permits established values such as `propose_patch`,
`github-read-only-validation`, and `analysis-only`, while rejecting prose,
paths, hostnames, URLs, header values, payloads, or credential-shaped
transport data.

The offline CLI profile also bounds each `maxTasksPerDay` to a safe integer
from `1` through `1000000`, consistent with the `tasksToday` upper bound. This
wrapper-only restriction does not change the shared broker policy validator or
evaluator semantics.

### Task envelope

`TASK.json` has the closed versioned shape:

```json
{
  "schemaVersion": "a2a.policy-referee.task.v1",
  "intent": "propose_patch",
  "mode": "propose-patch",
  "evaluationPoint": "claim",
  "tasksToday": 2
}
```

- `intent` is required and uses the canonical token rule above.
- `mode` is optional and uses the same token rule.
- `evaluationPoint` is required and is exactly `create` or `claim`.
- `tasksToday` is a safe integer from `0` through `1000000`. It is required
  only when the matched evaluator rule invokes `maxTasksPerDay`, and is
  rejected when the evaluator does not invoke that lazy counter. JSON never
  exposes a callback; the CLI converts this number to the existing evaluator's
  lazy `countTasksToday` function.

### Worker envelope

`WORKER.json` has the closed versioned shape:

```json
{
  "schemaVersion": "a2a.policy-referee.worker.v1",
  "workerClass": "source-only",
  "implementation": {
    "isImplementationIntent": true,
    "ready": false
  }
}
```

`workerClass` is exactly one anonymous class: `mobile`, `vps`, `source-only`,
or `unclassified`. Named-worker-shaped classes and `*` are not worker input
values (`*` remains policy-rule syntax only).

`implementation` is optional. When present, it contains exactly the two
booleans shown above. There is deliberately no blocker/detail string and no
worker, provider, model, account, host, path, URL, credential, token, header,
or payload field. Omitting the object at a claim-time implementation gate
preserves the evaluator's fail-closed “readiness missing” decision. An explicit
`create` evaluation preserves the evaluator's create-time opt-out.

## Decision output

For a valid evaluation, stdout contains exactly one compact JSON object plus
one newline:

```json
{"schemaVersion":"a2a.policy-referee.decision.v1","policyMode":"warn","action":"deny","ruleId":"source-analysis","reasonCode":"intent_not_allowed","enforceMode":{"deny":true,"requireApproval":false}}
```

The closed fields are:

- `schemaVersion`: always `a2a.policy-referee.decision.v1`;
- `policyMode`: `warn` or `enforce`, copied from the validated policy;
- `action`: `allow`, `deny`, or `require_approval`;
- `ruleId`: present only when the evaluator returns one;
- `reasonCode`: one of the stable codes below;
- `enforceMode`: booleans stating whether an enforce-mode caller would deny or
  require approval for this evaluator action.

The reason-code vocabulary is:

| Code | Evaluator result |
|---|---|
| `default_allow` | no matching rule and `defaultAction=allow` |
| `rule_allow` | matched rule allows |
| `default_deny` | no matching rule and `defaultAction=deny` |
| `mode_denied` | `denyModes` wins |
| `intent_not_allowed` | `allowIntents` denies |
| `implementation_readiness_missing` | claim-time readiness was omitted |
| `implementation_capability_unready` | implementation intent is not ready |
| `daily_budget_exhausted` | `tasksToday` is at or above the rule cap |
| `approval_required` | matched rule requires approval |

The CLI never writes evaluator free-form reasons. A deny decision exits as a
deny even when `policyMode` is `warn`; the CLI reports an offline policy
decision and does not apply the broker caller's warn/enforce behavior.

## Process exits

| Exit | Meaning |
|---:|---|
| `0` | allow decision |
| `10` | require-approval decision |
| `20` | deny decision |
| `64` | invalid usage, unreadable/invalid input, or closed-contract violation |
| `70` | internal or unexpected failure |

Invalid and internal cases write one bounded
`a2a.policy-referee.error.v1` JSON object to stderr. It contains only a stable
error `code`, the input slot (`arguments`, `policy`, `task`, or `worker`), and a
contract JSON `path`. The path is metadata such as `$.tasksToday`, never a
source filename. Errors do not reflect arguments, filesystem paths, document
contents, field names supplied by an attacker, rejected values, evaluator
reasons, or parser diagnostics. Invalid cases write nothing to stdout.

## Public-safe fixtures

The bounded golden manifest contains nine independently replayable
policy/task/worker/expected-decision-and-exit cases:

- matched allow;
- allow-intent deny;
- deny-mode precedence over intent and approval;
- require approval;
- daily-budget boundary;
- missing claim-time implementation readiness;
- unready claim-time implementation capability;
- create-time implementation opt-out;
- default deny.

Replay every golden case against the built bin:

```sh
npm run build -w packages/policy-referee
npm run fixtures:replay -w packages/policy-referee
```

The negative manifest covers unknown fields and versions, identity-bearing and
transport-bearing fields, worker-name-shaped classes, unsafe counts, arbitrary
implementation blocker prose, URL-shaped tokens, policy rejection,
prototype-key input, and malformed JSON. Package tests also cover non-plain
in-memory objects, missing files/arguments, exact stdout bytes, distinct exits,
evaluator precedence, and source-path/secret-sentinel non-reflection.

## Offline-only safety boundary

This CLI performs offline validation and evaluation only. It does not apply
policy, emit audits, create or claim tasks, authorize live enforcement, read or
change a live policy file, derive a live worker identity, access broker state,
or import broker runtime modules.

It also does not deploy or restart anything; send provider traffic; mutate a
database, outbox, ACK, replay, or prune state; change workflows, rulesets,
repository visibility, settings, or secrets; publish a package; create a
repository, release, or tag; or grant approval. Those remain separate,
explicitly authorized operations.

# Constrained node-op lane contract

Issue: [a2a-nexus#1459](https://github.com/jinwon-int/a2a-nexus/issues/1459)

## Scope

A `node-op` lane is a future A2A task type for approved, node-local fleet operations such as self-update checks, guard runs, and bounded configuration convergence. It exists to preserve broker auth, assignment, evidence, redaction, and finalizer flow for work that is node-local and cannot be represented as a GitHub patch lane.

This contract is **design-only**. It does not enable a broker route, worker executor, production deployment, Gateway/broker/worker restart, provider send, DB/outbox/ACK/replay/prune/migration, release publication, or secret movement.

## Explicit non-goal: raw shell or exec

A generic "run this command" task is prohibited. A node-op lane MUST NOT accept arbitrary shell strings, free-form command arrays, or operator-provided scripts. The edge secret must never become a fleet-wide remote-code-execution primitive.

Rejected shapes include:

```jsonc
{ "payload": { "mode": "node-op", "command": "bash -lc '...'" } }
{ "payload": { "mode": "node-op", "script": "curl ... | sh" } }
{ "payload": { "mode": "node-op", "args": ["--anything", "$(...)" ] } }
```

## Allowed task shape

A conforming task names an allowlisted operation and validated arguments, not a command:

```jsonc
{
  "intent": "node-op",
  "target": { "id": "node-id", "kind": "node", "role": "worker" },
  "assignedWorkerId": "node-id",
  "payload": {
    "mode": "node-op",
    "op": "converge-distill-peer",
    "opVersion": "1",
    "args": { "action": "check" },
    "writeCapable": false,
    "noLive": true
  },
  "policyContext": {
    "requiresApproval": false,
    "liveImpact": false
  }
}
```

Required payload fields:

- `mode: "node-op"`.
- `op`: an identifier present in the worker's approved operation manifest.
- `opVersion`: a pinned operation contract version.
- `args`: an object validated against the operation-specific JSON schema.
- `writeCapable`: boolean. `true` means the operation may change node-local state.
- `noLive`: boolean. `true` for read-only/check lanes; `false` is permitted only when a fresh operator approval explicitly covers the workstream.

## Operation allowlist

Workers MUST resolve `op` through a reviewed operation manifest. The manifest is the only place that maps operation names to repo-shipped scripts or helpers.

Each allowlist entry MUST declare:

- operation id and contract version;
- owning repo and reviewed path;
- allowed target node roles or broker scope;
- argument schema;
- whether the operation is read-only or write-capable;
- whether fresh approval is required;
- integrity requirement: immutable version, commit SHA, checksum, or signature sufficient to reject a drifted local copy;
- structured evidence schema;
- rollback or backup contract for write-capable operations.

Unknown `op`, unsupported `opVersion`, schema violation, missing integrity proof, or disallowed target scope MUST fail closed before any worker-side execution.

## Initial reference operations

The first implementation wave should define these reference operations before broader expansion:

| op | writeCapable | Purpose | Required evidence |
| --- | --- | --- | --- |
| `fleet-guard` | `false` | Run reviewed health/guard checks and report status without mutation. | `status`, `checkedAt`, guard name/version, redacted findings. |
| `converge-distill-peer` | `true` | Converge the node-local Honcho distill author peer using the reviewed ccc-node helper. | before/after peer, action, backup path, verification result, rollback path. |

`converge-distill-peer` MUST support a read-only `check` action before `apply`. An `apply` action MUST require fresh operator approval and MUST record a backup path before mutation.

## Gate requirements

### Create-time gate

A broker or dispatch validator MUST reject malformed node-op payloads before task creation:

- unknown mode/op/version;
- missing `assignedWorkerId` for node-local ops;
- free-form command/script fields;
- args that do not match the operation schema;
- `writeCapable=true` without approval context;
- target outside the broker's configured fleet scope.

### Claim-time gate

The worker MUST re-evaluate the same policy at claim time because allowlists, approvals, and node state may change after creation. A task that becomes disallowed MUST fail closed without executing the operation.

### Worker readiness gate

Write-capable node-op tasks MUST carry worker-readiness proof comparable to GitHub patch lanes: the worker must demonstrate the approved op exists, matches the pinned integrity requirement, can write only its declared local scope, and can produce the required structured evidence.

Read-only node-op tasks MAY use a lighter readiness check, but must still prove the resolved operation is allowlisted and integrity-checked.

## Evidence contract

Node-op workers MUST return structured evidence instead of raw stdout/stderr. The minimum evidence shape is:

```jsonc
{
  "op": "converge-distill-peer",
  "opVersion": "1",
  "action": "apply",
  "status": "applied",
  "targetNodeId": "node-id",
  "before": { "aiPeer": "old-value" },
  "after": { "aiPeer": "family-assistant" },
  "backupPath": "node-local path, if writeCapable",
  "verification": { "status": "converged" },
  "rollback": { "available": true, "method": "restore backup path" },
  "redaction": { "rawSecretsIncluded": false }
}
```

Evidence MUST be redacted before storage in broker tasks, issue comments, PR bodies, Wiki pages, or finalizer reports. Raw host logs may be retained node-locally only when the operation manifest permits it and names a retention boundary.

## Broker and fleet scope

T1 and T2 brokers may have different worker rosters and local operator secrets. A node-op task MUST run only on a worker registered to the broker of record or through an explicit cross-broker handoff. The initiating broker remains the finalizer and operator-facing owner unless a handoff document says otherwise.

A node-op lane MUST NOT use the broker edge secret to bypass SSH, OS permissions, ccc-node guards, or node-local approval rules. The worker is still responsible for enforcing its local guard profile.

## Rollback and idempotency

Node-op operations MUST be idempotent. Re-running a `check` must be safe. Re-running an `apply` must either report already-converged or create a new backup before any additional mutation.

Write-capable operations MUST document rollback. If rollback is impossible or manual-only, the operation must say so in the allowlist and require explicit operator approval before execution.

## Implementation sequence

1. Land this design contract and topology/constitution references.
2. Add a read-only validator/prototype for `fleet-guard` with fixture tests and no production executor.
3. Add `converge-distill-peer --check` as a read-only node-op canary.
4. Add `converge-distill-peer --apply` only after approval UX, worker readiness, integrity, and redaction tests exist.
5. Run no-live A2A canaries before any production deployment or worker restart.

## Closeout rules

A future node-op implementation PR may close a follow-up only when it includes:

- RED evidence showing the previous surface rejects or cannot express the node-local operation;
- GREEN validator tests for malformed payloads and allowed operations;
- worker-readiness tests for read-only and write-capable cases;
- evidence redaction tests;
- no-live canary readback;
- explicit statement that no raw shell, raw secret, DB mutation, replay/prune, provider send, release, deploy, or restart occurred unless separately approved.

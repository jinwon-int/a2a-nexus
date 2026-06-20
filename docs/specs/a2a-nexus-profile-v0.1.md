# A2A Nexus Protocol Profile v0.1

This profile defines the minimum public surface for A2A Nexus as a **broker-agnostic task/evidence plane**. It is intentionally smaller than a full implementation roadmap: the goal is to make workers, dispatchers, and finalizers agree on evidence semantics before any live broker, provider, deployment, release, DB/outbox, or secret operation is attempted.

Refs: #957, #958.

## Scope

The profile covers:

- Worker Card capability advertisement.
- Task lifecycle states shared across brokers.
- Terminal Evidence state transitions for operator-visible closeout.
- Source-only analysis lanes for A2AD review rounds.
- Finalizer quorum rules that distinguish substantive analysis from wrapper/transport success.

It **does not authorize any production deploy, broker/worker restart, DB mutation/replay, provider send, Terminal Brief ACK, release publish, repo visibility change, or secret movement**. Those remain explicit operator-approval actions.

## Worker Card

A Worker Card is a redaction-safe capability document published by or collected for a worker before dispatch.

Required fields:

| Field | Purpose |
|---|---|
| `workerId` | Stable worker/node identifier. |
| `teamId` | Routing team, e.g. `team1` or `team2`. |
| `homeBrokerId` | Broker of record for this worker. |
| `workerPlane` | `server`, `docker-runner`, `mobile`, or another explicit plane. |
| `supportedModes` | Task modes the worker can actually execute, e.g. `analysis-only`, `github-verify`, `github-propose-patch`. |
| `analysisRepoMap` | Repo-to-worktree map used for source-only repo analysis. Must include `jinwon-int/a2a-nexus` for Nexus repo-root analysis. |
| `terminalEvidence` | Whether the worker can produce PR / Done / Block evidence and which owner performs ACK. |

For A2AD opinion lanes over Nexus source, dispatch preflight must require:

```json
{
  "supportedModes": ["analysis-only"],
  "analysisRepoMap": {
    "jinwon-int/a2a-nexus": "/opt/a2a-broker-worker"
  }
}
```

A worker that is online but lacks `analysis-only`, or lacks a canonical repo map for `jinwon-int/a2a-nexus`, is not ready for the lane. This specifically keeps mobile/policy-limited workers such as Daegyo out of formal A2AD quorum unless they explicitly advertise the required mode.

## Task lifecycle

Baseline task states are broker-neutral:

1. `accepted` — broker accepted the task envelope.
2. `claimed` — a worker claimed the task.
3. `started` — execution began.
4. `provider_accepted` — an external provider accepted a send/request. This is transport evidence only.
5. `operator_visible` — result or brief is visible to the operator/finalizer.
6. `done` — terminal success with substantive output.
7. `blocked` — terminal blocked outcome with reason.
8. `failed` — terminal failure with reason.
9. `acknowledged` — operator/finalizer ACK after visibility and closeout checks.

`provider_accepted` is not a requester-visible receipt, not terminal ACK, and not enough to close an A2AD round.

## A2AD opinion lane mode

Pure A2AD opinion lanes must use:

```json
{
  "intent": "analyze",
  "payload": {
    "mode": "analysis-only",
    "roundMode": "a2ad",
    "sourceOnly": true,
    "noLive": true
  }
}
```

They must not use `intent=a2ad-review` as a generic wrapper, and they must not be routed through GitHub evidence modes (`github-verify`, `github-propose-patch`) unless the lane is explicitly a GitHub evidence lane with PR / Done / Block output contract.

## Terminal Evidence

Terminal Evidence is the closeout contract consumed by finalizers and operators.

Allowed terminal evidence classes:

| Class | Counts for A2AD quorum? | Meaning |
|---|---:|---|
| `substantive` | yes | Worker completed source-only analysis with usable findings/opinion. |
| `wrapper_only` | no | Generic handler/wrapper success, echo output, or no analysis payload. |
| `evidence_contract_failure` | no | Docker runner or GitHub lane failed to produce PR / Done / Block evidence. |
| `mobile_limited` | no | Worker is online/pending but cannot execute the requested mode. |
| `failed` | no | Terminal failed/blocked task. |
| `missing_evidence` | no | Pending, queued, or otherwise non-terminal. |

A finalizer may publish a FINAL A2AD consensus only when all configured quorum requirements are satisfied by `substantive` evidence, and the draft cites succeeded evidence IDs. Otherwise it must block or produce an explicitly preliminary body.

## Finalizer rules

The finalizer must:

- Count only substantive succeeded lanes toward quorum.
- Exclude `wrapper_only`, `evidence_contract_failure`, `mobile_limited`, failed, queued, and pending lanes.
- Preserve missing-lane details with worker, status, evidence class, and reason.
- Fail closed if the would-post draft cites no succeeded evidence IDs.
- Keep sourceOnly/noLive boundaries intact.

## Conformance fixtures

This repository carries two v0.1 fixtures:

- `contracts/a2a/worker-card.schema.json`
- `fixtures/contract/terminal-evidence-state-machine.json`

They are intentionally local/read-only and safe for CI.

# A2A Work Mode Pre-Dispatch Decision

This source-only packet records why a future A2A round should run as `solo`,
`team1`, or `hybrid` before any worker dispatch happens.

It is a decision/template artifact only. It does not dispatch workers, restart
services, mutate databases, ACK or replay Terminal Brief rows, send providers,
publish releases, move credentials, or change repository visibility.

## Usage

```bash
npm run work_mode_pre_dispatch_decision -- \
  --input fixtures/work-mode-pre-dispatch/team1-candidate-review.json
```

Use `--json` when the packet should be pasted into an issue, task manifest, or
round log as structured evidence.

## Worker Readiness Snapshot

Before recording `workers.capacityState=healthy` for a `team1` or `hybrid`
decision, use the broker-owned capacity surfaces:

- `GET /workers/capacity`
- `GET /dashboard`
- optional host-level `openclaw-a2a-worker.service` read-only checks when a
  worker looks stale, missing, or inconsistent

Do not use `GET /workers` or `GET /workers/:id` alone as the dispatch
GO/NO-GO signal. In SQLite deployments, unchanged worker heartbeat persistence
can be throttled, so those registry/detail read paths may show older persisted
`lastSeenAt` values even while `/workers/capacity` and `/dashboard` show current
online capacity.

For Seoseo/Gwakga broker checks, pass the edge secret through an environment
variable or local config reader and never paste, log, or commit the secret value:

```bash
curl -fsS \
  -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  "${A2A_BROKER_URL}/workers/capacity"
```

Classify the packet input as:

| `workers.capacityState` | Use when |
|---|---|
| `healthy` | Required workers are online in `/workers/capacity`, active/queued/claimed/running load is acceptable, and no stale assigned tasks block the lane. |
| `busy` | Workers are online but active/queued/claimed/running load would make a new round likely to collide or wait. |
| `stale` | Required workers are stale, missing, or have stale assigned work. |
| `degraded` | Capacity surfaces disagree in a way that affects routing, broker health is not OK, or host checks show worker service trouble. |
| `unknown` | Capacity was not checked or evidence is too old to trust. |

If capacity is anything other than `healthy`, prefer `solo` or stop for a
readiness follow-up before dispatching Team1/hybrid work.

## Dispatch Helper Integration

Team1 and common dispatch helper CLIs accept the same input fixture or a rendered
packet JSON through `--work-mode-decision`.

```bash
npm run team1_dispatch_wrapper -- \
  --run-id a2a-example-20260606T210000Z \
  --parent-issue https://github.com/jinwon-int/a2a-broker/issues/1253 \
  --child-issue https://github.com/jinwon-int/a2a-broker/issues/1276 \
  --worker yukson \
  --worker-present \
  --work-mode-decision fixtures/work-mode-pre-dispatch/team1-candidate-review.json \
  --markdown
```

If the decision recommends `solo`, the helper exits before building the dispatch
plan. The packet still does not authorize dispatch; it only prevents accidental
Team1/hybrid planning when the recorded routing decision says solo.

## Input Shape

```json
{
  "task": {
    "taskId": "example-team1-candidate-review",
    "repo": "jinwon-int/a2a-broker",
    "issueNumber": 1253,
    "workProfile": "candidate_review",
    "ambiguity": "high",
    "urgency": "normal",
    "desiredOptimization": "confidence",
    "hasIndependentEvidenceLanes": true,
    "hasMultipleCandidates": true,
    "hasConflictingRecommendations": true
  },
  "workers": {
    "capacityState": "healthy",
    "staleTasks": 0,
    "activeRounds": 0
  },
  "boundaries": {
    "liveDeployOrRestart": false,
    "dbMutation": false,
    "terminalAckOrReplay": false,
    "providerSend": false,
    "releaseOrVisibilityChange": false,
    "credentialOrSecretChange": false,
    "approvalSensitiveCloseout": false
  },
  "finalizerOwner": "seoseo"
}
```

## Work Profiles

| Profile | Typical decision |
|---|---|
| `narrow_source_fix` | `solo` |
| `predictable_docs_runbook` | `solo` |
| `known_path_bug` | `solo` |
| `ambiguous_rca` | `team1` when workers are healthy and lanes are independent |
| `candidate_review` | `team1` when candidates/evidence are independent |
| `approval_closeout` | `hybrid` or `solo` finalizer depending on runtime boundaries |
| `late_supplemental_review` | `hybrid` |
| `live_or_sensitive_boundary` | `solo` finalizer |

## Decision Semantics

The packet recommends `solo` when:

- the task is narrow, predictable, urgent, tightly coupled, or known-path;
- worker capacity is stale, busy, degraded, or unknown;
- live deploy/restart, DB mutation, Terminal Brief ACK/replay, provider send,
  release/visibility, or credential/secret movement is in scope.

The packet recommends `team1` when:

- workers are healthy;
- the work can split into independent evidence lanes;
- ambiguity, multiple candidate PRs, or conflicting recommendations justify
  broad evidence gathering.

The packet recommends `hybrid` when:

- Seoseo should keep implementation or finalizer authority;
- bounded helper evidence can reduce risk without handing off closeout.

## Output Guarantees

Every packet sets:

- `sourceOnlyDecision: true`
- `workerDispatchAllowedByThisPacket: false`
- `finalizerRequired: true`
- no service restart, DB mutation, Terminal Brief ACK/replay, provider send,
  release/visibility change, or credential/secret change

For `team1` and `hybrid`, required dispatch flags include:

- `one-finalizer-required`
- `evidence-only-helpers`
- `safe-parent-wording`
- `read-only-validation-for-no-change-lanes`
- `allow-no-changes-for-evidence-only-lanes`

## Fixtures

- `fixtures/work-mode-pre-dispatch/solo-known-path.json`
- `fixtures/work-mode-pre-dispatch/team1-candidate-review.json`
- `fixtures/work-mode-pre-dispatch/hybrid-supplemental-review.json`

## Related

- `docs/a2a-work-mode-routing-rules.md`
- `docs/a2a-work-mode-benchmark-analysis-2026-06-06.md`
- `docs/worker-subagent-orchestration-policy.md`

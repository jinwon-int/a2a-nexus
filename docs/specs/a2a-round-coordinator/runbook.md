# A2A Round Coordinator Operator Runbook

> **Runbook** for operators running the round coordinator poll/collect/bundle flow.
> Covers invocation, cursor management, backoff tuning, reading closeout bundles,
> handoff to the finalizer, and safe rollback.
>
> **Lane issue:** [a2a-plane#467](https://github.com/jinwon-int/a2a-plane/issues/467)
> **Parent tracker:** [a2a-broker#927](https://github.com/jinwon-int/a2a-broker/issues/927)
> **Broker/finalizer of record:** `seoseo`

---

## 1. Overview

The round coordinator is a deterministic collector that:

1. Polls the broker for task observations since the last cursor position.
2. Classifies each lane's status (pending/running/succeeded/failed/stale/timeout).
3. Builds a closeout bundle — a read-only JSON document — for human finalizer review.
4. Stops when all lanes are terminal or the deadline expires.
5. Never writes to GitHub, sends live messages, or performs approval-sensitive actions.

### 1.1 Command shape

```bash
# Start the coordinator for a round (one-shot poll)
node scripts/a2a-round-coordinator-collect.mjs \
  --manifest round-manifest.json \
  --cursor cursor.json \
  --bundle closeout-bundle.json

# Start with deadline and backoff (continuous polling)
node scripts/a2a-round-coordinator-collect.mjs \
  --manifest round-manifest.json \
  --cursor cursor.json \
  --bundle closeout-bundle.json \
  --deadline 2026-05-27T20:11:40Z \
  --continuous

# Dry-run: validate manifest and show expected output without running
node scripts/a2a-round-coordinator-collect.mjs \
  --manifest round-manifest.json \
  --dry-run

# Reset cursor to a known checkpoint
node scripts/a2a-round-coordinator-collect.mjs \
  --manifest round-manifest.json \
  --cursor cursor.json \
  --reset-cursor 2026-05-26T20:00:00Z
```

> **Note:** The `a2a-round-coordinator-collect.mjs` script is not yet implemented.
> The current valid validation path uses the libero test scripts in `scripts/`:
> - [`scripts/check-parent-round-closeout-go-nogo-matrix.mjs`](../../../scripts/check-parent-round-closeout-go-nogo-matrix.mjs)
>   validates the closeout go/no-go matrix schema and gate evaluation.
> - `scripts/check-team1-*.test.mjs` scripts validate individual round-coordinator
>   artefacts (spec, runbook, schema) via Node.js `--test`.
>
> Example — validate the round coordinator spec against the libero checklist:
>
> ```bash
> node --test scripts/check-team1-nosuk-round-coordinator-libero.test.mjs 2>/dev/null || \
>   echo "Use the libero validation checklist in docs/validation/team1-nosuk-round-coordinator-libero.md"
> ```

### 1.2 Default behavior

- **Mode:** one-shot poll by default (query once, classify, write bundle, exit).
- **Continuous mode:** `--continuous` enables polling loop with backoff (see §3).
- **Dry-run mode:** validate manifest, cursor, and config — no broker queries, no bundle write.

## 2. Round manifest

The round manifest defines the round and its expected workers. It is created by
the dispatch wrapper or manually by the operator.

### 2.1 Manifest format

```json
{
  "$schemaVersion": "a2a.round-coordinator.manifest.v1",
  "roundId": "a2a-team1-<descriptor>-<timestamp>",
  "parentIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
  "team": "team1",
  "originBrokerId": "seoseo",
  "brokerOfRecordId": "seoseo",
  "parentBrokerId": "seoseo",
  "deadline": "2026-05-27T20:11:40Z",
  "staleAfterMs": 1800000,
  "policyContext": "source-only",
  "brokerEndpoint": "http://localhost:3000",
  "workers": [
    {
      "order": 1,
      "workerId": "bangtong",
      "repo": "jinwon-int/a2a-plane",
      "role": "broker",
      "githubIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
      "noLive": true,
      "noMutation": true,
      "lowPower": false,
      "mobileStandby": false,
      "staleAfterMs": 1800000,
      "timeoutMs": 7200000
    },
    {
      "order": 2,
      "workerId": "sogyo",
      "repo": "jinwon-int/a2a-plane",
      "role": "plugin",
      "githubIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
      "noLive": true,
      "noMutation": true,
      "lowPower": false,
      "mobileStandby": false
    },
    {
      "order": 3,
      "workerId": "nosuk",
      "repo": "jinwon-int/a2a-plane",
      "role": "runner",
      "githubIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
      "noLive": true,
      "noMutation": true,
      "lowPower": false,
      "mobileStandby": false
    },
    {
      "order": 4,
      "workerId": "yukson",
      "repo": "jinwon-int/a2a-plane",
      "role": "validation",
      "githubIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
      "noLive": true,
      "noMutation": true,
      "lowPower": false,
      "mobileStandby": false
    }
  ]
}
```

### 2.2 Team2 and cross-team manifests

For a Team2 round, set `team: "team2"` and use the Team2 worker roster.
For a cross-team round, set `team: "cross-team"` and list workers from both teams.

```json
{
  "roundId": "a2a-cross-team-terminal-brief-20260522T140000Z",
  "team": "cross-team",
  "originBrokerId": "seoseo",
  "parentBrokerId": "seoseo",
  "workers": [
    { "order": 1, "workerId": "bangtong", "repo": "jinwon-int/a2a-plane", "role": "broker" },
    { "order": 2, "workerId": "sogyo",   "repo": "jinwon-int/a2a-plane", "role": "plugin" },
    { "order": 3, "workerId": "soonwook","repo": "jinwon-int/a2a-plane", "role": "broker" },
    { "order": 4, "workerId": "gwakga",  "repo": "jinwon-int/a2a-plane", "role": "worker" }
  ]
}
```

### 2.3 Mobile standby lanes

Workers with `mobileStandby: true` (e.g., Gongyung/Hermes) are tracked but their
absence does not block the round from reaching `READY`. Their status is included
in the bundle for awareness.

### 2.4 Gongyung/Hermes example manifest entry

```json
{
  "order": 5,
  "workerId": "gongyung",
  "repo": "jinwon-int/a2a-plane",
  "role": "mobile-standby",
  "githubIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
  "noLive": true,
  "noMutation": true,
  "lowPower": true,
  "mobileStandby": true,
  "staleAfterMs": 300000,
  "timeoutMs": 3600000
}
```

## 3. Cursor management

The cursor tracks the coordinator's position in broker task event history.

### 3.1 Cursor file format

```json
{
  "roundId": "a2a-team1-<descriptor>-<timestamp>",
  "latestObservedAt": "2026-05-26T20:11:40Z",
  "observedTaskIds": ["task-uuid-1", "task-uuid-2"],
  "pollCount": 5,
  "lastBackoffMs": 10000,
  "deadlineReached": false,
  "state": "TRACKING"
}
```

### 3.2 Initial cursor

Before the first poll, create a seed cursor:

```bash
node scripts/a2a-round-coordinator-collect.mjs \
  --manifest round-manifest.json \
  --seed-cursor cursor.json
```

This writes a cursor with `latestObservedAt` set to the current timestamp
(minus a small buffer to catch in-flight tasks).

### 3.3 Reset cursor

If the coordinator needs to re-observe from a specific point:

```bash
node scripts/a2a-round-coordinator-collect.mjs \
  --manifest round-manifest.json \
  --cursor cursor.json \
  --reset-cursor 2026-05-26T20:00:00Z
```

This resets `latestObservedAt` and clears `observedTaskIds`. No broker
state is mutated — only the local cursor checkpoint is updated.

### 3.4 Cursor persistence

The cursor file is the only mutable state the coordinator owns. It should be:

- Stored in a durable location (broker filesystem or /work/artifacts in docker runner)
- Backed up before any reset operation
- Checked for corruption before each poll (valid JSON, non-future timestamps)

## 4. Backoff tuning

### 4.1 Default parameters

| Parameter | Default | Description |
|---|---|---|
| `initialIntervalMs` | 5_000 | First poll delay after entering TRACKING |
| `maxIntervalMs` | 300_000 | Maximum delay (5 min) |
| `backoffFactor` | 2.0 | Exponential factor |
| `jitterRatio` | 0.2 | ±20% random jitter |
| `fastPollCount` | 3 | Quick polls before backoff begins |

### 4.2 Override via manifest

Add a `backoff` block to the round manifest to override:

```json
{
  "backoff": {
    "initialIntervalMs": 10000,
    "maxIntervalMs": 600000,
    "backoffFactor": 1.5,
    "jitterRatio": 0.1,
    "fastPollCount": 5
  }
}
```

### 4.3 When progress resets backoff

Whenever a poll returns new observations (any lane status changed), the backoff
resets to `initialIntervalMs`. This ensures the coordinator polls briskly when
work is progressing and backs off when nothing is changing.

## 5. Reading the closeout bundle

When the coordinator exits (either all lanes terminal or deadline reached), it
writes a closeout bundle.

### 5.1 Bundle location

- Default: stdout (for immediate operator inspection)
- With `--bundle <path>`: written to the specified file path
- Inside docker runner: `/work/artifacts/round-closeout-bundle.json`

### 5.2 Quick inspection

```bash
# Check overall state
cat closeout-bundle.json | jq '{ state, partial, decision: .summary }'

# List non-terminal lanes
cat closeout-bundle.json | jq '.lanes[] | select(.status != "succeeded" and .status != "blocked" and .status != "cancelled")'

# List risks
cat closeout-bundle.json | jq '.risks[]'

# Check finalizer action gates
cat closeout-bundle.json | jq '.finalizerAction'
```

### 5.3 Interpreting state

| Bundle state | Meaning | Near-term action |
|---|---|---|
| `READY` | All lanes terminal, bundle complete | Hand off to Seoseo for final closeout |
| `READY_PARTIAL` | Some lanes terminal, some timed out or stale | Seoseo decides retry or partial close |
| `TRACKING` | Still collecting (bundle written mid-poll for snapshot) | Wait for completion |

## 6. Handoff to finalizer

### 6.1 When to hand off

Hand the closeout bundle to Seoseo when:

- Bundle state is `READY` (all lanes terminal), OR
- Bundle state is `READY_PARTIAL` and Seoseo approves partial closeout, OR
- Bundle contains a `BLOCKED` lane that needs operator escalation.

### 6.2 Handoff packet

The handoff packet includes:

1. The closeout bundle JSON (from `--bundle` path).
2. The cursor checkpoint (for idempotent replay).
3. The round manifest.
4. The deadline timestamp.

### 6.3 Finalizer review steps

Seoseo reviews the bundle, then runs the existing parent-round closeout go/no-go
matrix (documented in `docs/specs/a2a-parent-round-closeout-go-nogo/runbook.md`):

```bash
node scripts/check-parent-round-closeout-go-nogo-matrix.mjs \
  --spec docs/specs/a2a-parent-round-closeout-go-nogo/schema.json \
  --fixture <path-to-bundle-derived-fixture.json>
```

The matrix produces the final GO/NO_GO/BLOCKED decision. Seoseo then:

- **GO:** Posts a Go decision comment and closes the parent issue.
- **NO_GO:** Posts a No-Go comment explaining what must be resolved.
- **BLOCKED:** Escalates to operator review; does not close.

### 6.4 Finalizer of record

`seoseo` is the broker/finalizer of record for all Team1 parent rounds.
No other entity may close the parent issue or render the aggregate decision.
The coordinator does not post comments, close issues, or produce final decisions.

## 7. Safe rollback

### 7.1 Rollback scenarios

| Scenario | Rollback procedure |
|---|---|
| Incorrect lane classification | Reset cursor to before the misclassification, re-run |
| Wrong deadline set | Update manifest, re-run; cursor unaffected |
| Bundle contains stale data | Reset cursor, re-run with `--continuous` |
| Service restart mid-poll | Cursor checkpoint survives; coordinator resumes from last cursor |
| Corrupt cursor file | Restore from backup or use `--reset-cursor` |

### 7.2 What rollback does NOT do

- No GitHub comments or issues are created or deleted.
- No broker task state is mutated.
- No terminal-outbox ACK is performed.
- No live provider message is sent.
- No database mutation occurs.

Rollback is purely a local state operation (restore cursor checkpoint, re-run).

### 7.3 Idempotency guarantee

Re-running the coordinator with the same cursor and manifest produces the
same closeout bundle (modulo timestamps). Bundles with identical lane evidence
and same `observedTaskIds` are considered equivalent.

## 8. Verification

### 8.1 Pre-flight checks

Before running the coordinator against a real round:

1. Validate the manifest against the schema (see §11.2 for source-only manifest validation).
2. Verify the broker endpoint is reachable.
3. Verify the cursor file is readable and not malformed.
4. Verify the deadline is in the future (if set).
5. Verify no stale cursor state exists (cursor `updatedAt` not in the future).
6. Verify runtime/bootstrap files are absent from the repo branch.

### 8.2 Post-collection verification

After the bundle is generated:

1. Verify all expected workers are present in `lanes[]`.
2. Verify no lane has `status: "pending"` unless deadline was reached.
3. Verify evidence URLs are well-formed (https://github.com/...).
4. Verify no evidence URLs point to raw secrets, private paths, or session dumps.
5. Verify `safetyConfirmation` block has all flags set to `true`.
6. Verify `finalizerAction.required` is `true` (human must review).

### 8.3 Validation test

> **Note:** `scripts/a2a-round-coordinator-collect.mjs` is not yet implemented.
> The current valid validation path uses the parent-round closeout go/no-go matrix
> script or the dry-run aggregator:

```bash
# Validate via closeout go/no-go matrix (exists)
node scripts/check-parent-round-closeout-go-nogo-matrix.mjs \
  --spec docs/specs/a2a-parent-round-closeout-go-nogo/schema.json \
  --fixture fixtures/contract/parent-round-closeout-go-nogo-matrix.json

# Validate via source-dryrun aggregator (exists)
node scripts/a2a-source-dryrun-aggregator.mjs \
  --spec docs/dry-run/source-public-dryrun-schema.json

# Validate round coordinator artefacts with libero test suite
node --test scripts/check-team1-source-dryrun-orchestrator-libero.test.mjs
```

A dry-run that exits 0 validates the manifest and configuration without querying
the broker or writing the bundle.

## 9. Risk notes

| Risk | Mitigation |
|---|---|
| Broker endpoint unreachable | Coordinator exits with clear error; cursor unchanged; retry safe |
| Stale cursor leads to missed observations | Use `--reset-cursor` to a point before the round started |
| Backoff causes delay on fast workers | `fastPollCount=3` catches early completions; progress resets backoff |
| Deadline set too short | Update manifest deadline, re-run with same cursor |
| Misclassified lane status | Override via cursor reset + re-run, or manual overrides in bundle |
| Closeout bundle contains secrets | Coordinator never reads/writes secrets; evidence URLs validated |
| Cross-team round coordination | Bundle includes team labels; finalizer reviews across team boundaries |

## 10. Emergency stop

If the coordinator is misbehaving (e.g., polling too fast, classifying incorrectly):

1. Send SIGINT (Ctrl+C) to stop the process.
2. The cursor checkpoint file is not written mid-poll; the last complete poll's cursor is safe.
3. Delete or archive the erroneous bundle (no data was mutated).
4. Reset the cursor if needed (see §3.3).
5. Fix the manifest or configuration and re-run.

Do not:
- Delete broker task state
- Delete GitHub issues or comments
- Send any live provider messages
- Mutate the terminal outbox

## 11. Source-only dispatch manifest and dry-run closeout flow

### 11.1 Source-only dispatch manifest flow

The round coordinator consumes manifests created by the dispatch wrapper or by an
operator. The `policyContext` field in the manifest communicates the dispatch's
safety boundary:

- `"policyContext": "source-only"` — all lanes are assumed to be source/doc/tests
  only. The coordinator enforces the same safety gates as the dispatch wrapper
  (no deploy, no restart, no live send, no DB mutation, no terminal ACK).
- Any other value (or missing) — the coordinator defaults to `source-only` semantics
  unless explicitly overridden by operator approval on the parent issue.

The manifest's `policyContext` flows to the closeout bundle's
`safetyConfirmation` block. Every bundle generated by the coordinator must have
all safety flags set to `true` when `policyContext` is `"source-only"`. If a
`policyContext` override is present, the `safetyConfirmation` block must include
an audit trail referencing the operator approval comment.

**Source-only manifest entry (dispatch wrapper §2.1):**

```json
{
  ...
  "policyContext": "source-only",
  "dryRunDefault": true,
  ...
}
```

The coordinator does not produce, publish, or distribute the dispatch manifest.
It only consumes it. The dispatch wrapper is the manifest's source of truth.

### 11.2 Dry-run closeout flow

When a round is in dry-run mode (or the manifest has `policyContext: "source-only"`
and `dryRunDefault: true`), the coordinator's closeout flow behaves as follows:

| Aspect | Dry-run mode | Execute mode (future implementation) |
|---|---|---|
| Broker task queries | Validates query parameters only; no real call | Queries broker `/tasks` endpoint |
| Lane classification | Emulates classification from synthetic or replay data | Real classification from broker observations |
| Closeout bundle | Generates bundle template with all fields, using placeholder evidence | Full bundle with real evidence URLs |
| Bundle confidentiality | Same redaction rules apply | Same redaction rules apply |
| Finalizer handoff | Bundle is informational only; no finalizer action required | Seoseo must review and decide |
| Post-run artifacts | Writes dry-run bundle to stdout or `--bundle` path | Writes final bundle to `--bundle` path |
| State transition | Does not transition the round state | Transitions through the lifecycle |

**Dry-run closeout bundle vs execute-mode bundle:**

In dry-run mode, the bundle carries a `dryRun: true` flag at the root level.
The `finalizerAction.required` is set to `false` because no real collection
has occurred. The `summary` block contains zero counts for terminal lanes
unless fed from synthetic fixture data.

```json
{
  "$schemaVersion": "a2a.round-coordinator.closeout-bundle.v1",
  "roundId": "a2a-team1-<descriptor>-<timestamp>",
  "generatedAt": "<ISO-8601>",
  "state": "DRY_RUN",
  "dryRun": true,
  "partial": false,
  "lanes": [],
  "summary": {
    "totalLanes": 4,
    "terminal": 0,
    "pending": 4
  },
  "finalizerAction": {
    "required": false,
    "recommended": "NONE"
  },
  "safetyConfirmation": {
    "noProductionDeploy": true,
    ...
  }
}
```

**Validation path (current):**

Since `scripts/a2a-round-coordinator-collect.mjs` is not yet implemented, the
dry-run closeout flow can be validated via the existing libero validation
checklist at [`docs/validation/team1-nosuk-round-coordinator-libero.md`](../validation/team1-nosuk-round-coordinator-libero.md)
and via the parent-round closeout go/no-go matrix:

```bash
node scripts/check-parent-round-closeout-go-nogo-matrix.mjs \
  --spec docs/specs/a2a-parent-round-closeout-go-nogo/schema.json \
  --round-metadata docs/specs/a2a-round-coordinator/schema.json \
  --lane-evidence fixtures/contract/parent-round-closeout-go-nogo-matrix.json \
  --mode comment_only
```

This verifies that the bundle schema, gate definitions, and safety semantics
are consistent between the round coordinator and the closeout matrix — without
requiring the collector script.

### 11.3 Closing note on source-only semantics

The round coordinator inherits the dispatch wrapper's source-only safety
boundary. All coordinator actions (polling, classification, bundle generation)
must remain read-only. No coordinator operation may:

- Deploy, restart, or reconfigure a broker/worker/Gateway
- Send live provider messages (Telegram, etc.)
- Mutate the broker's task database
- ACK or replay a terminal outbox
- Publish any release, tag, or npm package
- Move or expose credentials or secrets
- Change repository visibility
- Force-push or rewrite history
- Close or merge any issue or PR automatically
- Post comments or close issues on behalf of a human finalizer

These restrictions remain in effect even during dry-run closeout — dry-run mode
produces informational artifacts only, never live side effects.

## 12. Related documents

- [Round coordinator spec](./spec.md)
- [Round coordinator schema](./schema.json)
- [Source-only dispatch manifest spec (dispatch-wrapper runbook)](../a2a-team1-dispatch-wrapper/runbook.md#2-round-spec-shape)
- [Parent-round closeout go/no-go runbook](../a2a-parent-round-closeout-go-nogo/runbook.md)
- [Dry-run tooling docs](../../dry-run/README.md)
- [Team1 dispatch-wrapper runbook](../a2a-team1-dispatch-wrapper/runbook.md)
- [Round coordinator libero validation checklist](../../validation/team1-nosuk-round-coordinator-libero.md)
- [Docker runner README](../../../packages/docker-runner/README.md)

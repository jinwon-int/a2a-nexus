# A2A Team1 Dispatch-Wrapper Operator Runbook

> **Operator runbook** for the broker-alpha-operated Team1 dispatch wrapper (`team1-dispatch`).
> Covers round spec shape, parent-round metadata propagation, dry-run vs execute mode,
> approval boundaries, sanitized run record, idempotency expectations, worker-online
> preflight, read-only follow-up check, and finalizer closeout handoff.
>
> **Lane issue:** a2a-plane#404 (a2a-plane#404, internal tracker private)
> **Parent tracker:** [a2a-broker#847](https://github.com/jinwon-int/a2a-broker/issues/847)
> **Broker/finalizer of record:** `broker-alpha`

---

## 1. Overview

The Team1 dispatch wrapper is a deterministic script/command that reduces the broker-alpha
operator's front-end orchestration friction for A2A Team1 parent rounds. It replaces
the manual 4-step process (create parent issue, create 4 child issues, add metadata
comments, dispatch broker `/tasks` calls) with a single command invocation.

### 1.1 Command shape

```text
team1-dispatch --spec round.json --dry-run
team1-dispatch --spec round.json --execute
team1-dispatch --spec round.json --execute --follow-up-interval 60
```

- `--spec round.json` — path to a structured round spec (see §2).
- `--dry-run` — default mode; validate the spec, check preflight conditions, and emit
  a JSON run record without creating GitHub issues or broker tasks.
- `--execute` — explicit opt-in mode; create parent issue, child issues, metadata
  comments, broker tasks, and write the final run record.
- `--follow-up-interval 60` — optional; schedule a read-only status check every N
  seconds for the round (see §8).

### 1.2 Default execution mode

The **default mode is `--dry-run`**. Real GitHub issue creation, broker `/tasks` writes,
or any external side effect require explicit `--execute`. A dispatch invoked without
`--execute` or `--dry-run` is treated as `--dry-run`.

### 1.3 Scope

| In scope | Out of scope |
|---|---|
| Create parent GitHub issue with round metadata body | Production deploy, Gateway/broker/worker restart |
| Create N child/lane issues with metadata comments | Live provider/Telegram canary or notification |
| Add parent-round metadata as issue body preamble | Production DB mutation, prune, or migration |
| Dispatch broker `/tasks` requests with canonical payloads | Terminal-outbox ACK or replay |
| Add broker task id/status comments to child issues | Historical outbox replay |
| Write sanitized JSON run record | Live GitHub auto-close of issues |
| Optional read-only follow-up status check | Release, tag, or npm publish |
| Worker-online preflight check before execution | Credential movement or secret disclosure |
| Idempotency guard against duplicate dispatch | Repository visibility change |

## 2. Round spec shape

The round spec is a JSON file passed via `--spec`. It defines the parent round and
exactly four child lanes by default.

### 2.1 Schema

```json
{
  "$schemaVersion": "a2a.team1.dispatch-round.v1",
  "runId": "a2a-team1-<descriptor>-<timestamp>",
  "team": "team1",
  "brokerOfRecordId": "broker-alpha",
  "originBrokerId": "broker-alpha",
  "parentBrokerId": "broker-alpha",
  "parentTitle": "Short parent round title",
  "parentBody": "Parent GitHub issue body (markdown)",
  "policyContext": "source-only",
  "dryRunDefault": true,
  "lanes": [
    {
      "order": 1,
      "worker": "<worker-id>",
      "repo": "<org>/<repo>",
      "issueTitle": "Lane issue title",
      "focus": "Task prompt or focus text",
      "role": "broker|plugin|runner|libero",
      "labels": ["team1"]
    },
    {
      "order": 2,
      "worker": "<worker-id>",
      "repo": "<org>/<repo>",
      "issueTitle": "Lane issue title",
      "focus": "Task prompt or focus text",
      "role": "...",
      "labels": ["team1"]
    },
    {
      "order": 3,
      "worker": "<worker-id>",
      "repo": "<org>/<repo>",
      "issueTitle": "Lane issue title",
      "focus": "Task prompt or focus text",
      "role": "...",
      "labels": ["team1"]
    },
    {
      "order": 4,
      "worker": "<worker-id>",
      "repo": "<org>/<repo>",
      "issueTitle": "Lane issue title",
      "focus": "Task prompt or focus text",
      "role": "...",
      "labels": ["team1"]
    }
  ]
}
```

### 2.2 Default lane count

The default lane count is **exactly 4** (one each for broker, plugin, runner, libero).
A spec with fewer or more lanes requires explicit `--allow-nonstandard-lanes` flag.
This prevents accidental partial dispatch.

### 2.3 Run ID generation

If `runId` is not provided in the spec, the wrapper generates it automatically:

```text
a2a-team1-<descriptor>-<utc-timestamp>
```

The descriptor is derived from the first lane's focus or parent title, sanitised to
alphanumeric/hyphen characters. The timestamp is ISO-8601 compact (e.g. `20260520T235500Z`).

## 3. Required parentRound metadata

Every child lane and broker task must carry the full parent-round metadata block.
The wrapper enforces that these fields are present and non-empty before any write.

### 3.1 Metadata block (injected into each lane issue body and broker task payload)

```json
{
  "parentRoundId": "<runId or explicit id>",
  "parentRoundTotal": <lane count>,
  "parentRoundOrder": <1-based lane index>,
  "parentRoundProgress": "<order>/<total>",
  "originBrokerId": "broker-alpha",
  "brokerOfRecordId": "broker-alpha",
  "parentBrokerId": "broker-alpha"
}
```

### 3.2 Fail-closed rules

| Condition | Behaviour |
|---|---|
| Missing `parentRoundId` | Refuse all writes; emit Block evidence |
| Missing `parentRoundTotal` | Refuse all writes; emit Block evidence |
| Missing `parentRoundOrder` for any lane | Refuse all writes; emit Block evidence |
| Duplicate `parentRoundId` detected | Refuse all writes; see §6 idempotency |
| Mismatch between lane count and `parentRoundTotal` | Refuse all writes; emit Block evidence |
| `originBrokerId` does not match `--broker-of-record` flag | Refuse all writes; emit Block evidence |

### 3.3 Progress tracking

`parentRoundProgress` is maintained as `"<order>/<total>"` on each child (e.g. `"1/4"`)
so individual lanes can be identified as part of a sequence without querying the parent.

## 4. Dry-run vs execute mode

### 4.1 Dry-run mode (`--dry-run`)

1. Parse and validate the round spec.
2. Check preflight conditions (see §7).
3. Derive `runId` if not provided.
4. Emit a full JSON run record to stdout with all fields populated but no writes.
5. Exit 0 on success, non-zero on validation failure.

No GitHub API calls, no broker `/tasks` calls, no filesystem writes outside
the run record output.

### 4.2 Execute mode (`--execute`)

1. Run all dry-run validation steps first (fail fast on invalid spec).
2. Run worker-online preflight (see §7).
3. Create parent GitHub issue.
4. Create child lane issues with metadata comments.
5. Dispatch broker `/tasks` requests for each lane with canonical payload.
6. Add broker task id/status comments to each child issue.
7. Post dispatch summary comment on the parent issue.
8. Write sanitized JSON run record.
9. Optionally schedule read-only follow-up (see §8).

### 4.3 Partial failure handling

If any step fails after some writes have occurred:

- Emit a `Block` evidence record with the partial state.
- Do not attempt to auto-rollback GitHub issue creation (issues are immutable evidence).
- Record which lanes were created and which failed in the run record.
- The operator must review and manually resolve partial state before retry.

## 5. Approval boundaries

### 5.1 Default policy context

The default policy context is `source-only` and `no-live-impact`. This means:

- All dispatches are assumed to be documentation, tests, or source-only changes only.
- No production deploy, worker/broker/Gateway restart, live provider/Telegram message,
  production DB mutation, terminal-outbox ACK, release/tag/publish, or credential
  movement is allowed under the default context.

### 5.2 Override requirements

Changing the policy context to allow any of the above requires **both**:

1. An explicit `--policy-context <override>` flag on the command line, AND
2. A separate explicit operator approval comment on the parent issue naming the
   specific override action.

The wrapper must refuse to execute if one is present without the other.

### 5.3 Prohibited actions

The wrapper must refuse or require a separate explicit override for:

- Production deploy/restart of Gateway, broker, or worker
- Live provider/Telegram canary or notification send
- Production DB mutation, prune, or migration
- Terminal-outbox ACK or replay
- Historical outbox replay
- Live GitHub auto-comment/close execution
- Release, tag, or npm publish
- Credential movement or secret value disclosure
- Repository visibility change
- History rewrite or force-push

### 5.4 Evidence vs approval

Start, PR, Done, Block, and test-evidence comments are **evidence only**, not
operator approval. A separate explicit operator comment naming the specific action
and scope is required for any live-impact operation.

## 6. Idempotency expectations

### 6.1 Idempotency key derivation

Each dispatch invocation derives an idempotency key:

```text
a2a-team1-dispatch:<parentRoundId>:<originBrokerId>:<runTimestamp>
```

### 6.2 Replay detection

Before creating any GitHub issues or broker tasks:

1. Check if the idempotency key has been used before (stored in a local
   `dispatch-history.json` or broker idempotency store).
2. If a prior run with the same key exists AND the spec hash matches, return
   the existing run record and exit 0 (no-op replay).
3. If a prior run with the same key exists BUT the spec hash differs, refuse
   all writes and emit Block evidence (idempotency conflict).
4. If no prior run exists, proceed normally.

### 6.3 Broker task idempotency

Each broker `/tasks` call carries the lane's idempotency key:

```text
<parentRoundId>:<lane-order>:<worker>
```

The broker must return the existing task if the key has been used. The wrapper
must handle `409 Conflict` responses gracefully and treat them as replay success
if the existing task matches the expected payload.

### 6.4 GitHub issue idempotency

The wrapper should check for existing issues with the same parent metadata
before creating new ones. Specifically:

1. Check if a GitHub issue already exists for the parent round id and lane role.
2. If an existing issue is found with matching metadata, treat it as a replay
   and add a continuation comment rather than creating a duplicate issue.
3. If an existing issue is found with conflicting metadata, emit Block evidence.

## 7. Worker-online preflight

### 7.1 Preflight checklist

Before `--execute` creates any external artifacts, it must run:

| Check | Method | Fail action |
|---|---|---|
| Worker `doctor` status | Run `a2a-docker-runner doctor` or equivalent health check | Block evidence; no dispatch |
| Worker `githubPatch.status` | Parse doctor JSON output | Block evidence if `fail` |
| Broker health | `GET /health` on the broker endpoint | Block evidence if not ok |
| Queue sanity | `GET /tasks?state=queued,claimed,running` | Warn if non-zero; block if stale tasks found |
| Spec validity | Parse and validate round spec JSON | Block evidence on parse failure |
| Metadata completeness | Check all required parentRound fields | Block evidence on missing field |
| Idempotency | Check for existing run with same key | Block evidence on conflict |
| Policy context | Verify default or explicitly set | Block evidence on missing context |

### 7.2 Worker list

The expected workers for Team1 are:

| Worker | Role | Capability |
|---|---|---|
| `worker-gamma` | Broker source lane | GitHub patch, docs, typescript |
| `worker-beta` | Plugin source lane | OpenClaw plugin, typescript |
| `worker-alpha` | Runner/libero lane | Docker runner, docs, validation |
| `worker-delta` | Sibling validation | Cross-check, validation |

The preflight should verify at least three of four workers show `ok` status
(one may be intentionally offline for maintenance without blocking the round).

### 7.3 Read-only preflight

In `--dry-run` mode, the preflight runs read-only checks only. It does not
mutate any external state. It emits a preflight report as part of the run record.

## 8. Read-only follow-up check

### 8.1 Purpose

After dispatch, the operator may want periodic status updates on the round
without manual inspection. The wrapper can schedule a read-only follow-up
check that queries lane status at intervals.

### 8.2 Behaviour

```bash
# Schedule a follow-up check every 60 seconds:
team1-dispatch --spec round.json --execute --follow-up-interval 60
```

- The follow-up is **read-only**: it queries broker `/tasks?parentRoundId=<id>`
  and posts status as a comment on the parent issue (when explicitly requested).
- It never mutates task state, creates new issues, or ACKs terminal evidence.
- It stops when all lanes reach a terminal state or when cancelled by the operator.
- If `--follow-up-interval` is not provided, no follow-up is scheduled.

### 8.3 Output format

Each follow-up status comment contains:

```text
### Dispatch follow-up #<n> — <timestamp>

| Lane | Worker | Status | Evidence |
|---|---|---|---|
| 1/4 | worker-gamma | running | — |
| 2/4 | worker-beta | pr | PR #123 |
| 3/4 | worker-alpha | queued | — |
| 4/4 | worker-delta | done | Done |

3/4 lanes terminal. Follow-up continues every 60s.
```

## 9. Sanitized run record

### 9.1 Record format

After `--execute` completes (or `--dry-run` validates), the wrapper emits a
sanitized JSON run record:

```json
{
  "$schemaVersion": "a2a.team1.dispatch-run-record.v1",
  "runId": "a2a-team1-<descriptor>-<timestamp>",
  "executionMode": "dry-run|execute",
  "policyContext": "source-only",
  "brokerOfRecordId": "broker-alpha",
  "originBrokerId": "broker-alpha",
  "parentBrokerId": "broker-alpha",
  "parentRoundTotal": 4,
  "parentIssueUrl": "a2a-plane (internal tracker, private)issues/N",
  "startedAt": "<ISO-8601>",
  "completedAt": "<ISO-8601>",
  "idempotencyKey": "a2a-team1-dispatch:<runId>:broker-alpha:<timestamp>",
  "idempotencyConflict": false,
  "lanes": [
    {
      "order": 1,
      "worker": "worker-gamma",
      "repo": "a2a-plane (internal tracker, private)",
      "issueUrl": "a2a-plane (internal tracker, private)issues/N",
      "brokerTaskId": "task-uuid-1",
      "brokerTaskUrl": "https://broker.internal/tasks/task-uuid-1",
      "status": "queued|claimed|running|done|pr|blocked|cancelled",
      "evidenceUrl": null
    }
  ],
  "preflight": {
    "workerStatus": { "worker-gamma": "ok", "worker-beta": "ok", "worker-alpha": "ok", "worker-delta": "ok" },
    "brokerHealth": true,
    "queueStale": false,
    "specValid": true,
    "metadataComplete": true,
    "idempotencyOk": true
  },
  "warnings": [],
  "safetyConfirmation": {
    "noProductionDeploy": true,
    "noGatewayRestart": true,
    "noBrokerWorkerRestart": true,
    "noLiveProviderSend": true,
    "noDbMutation": true,
    "noTerminalAck": true,
    "noOutboxReplay": true,
    "noReleaseTagPublish": true,
    "noCredentialMovement": true,
    "noSecretDisclosure": true,
    "noVisibilityChange": true,
    "noHistoryRewrite": true,
    "noForcePush": true
  }
}
```

### 9.2 Redaction rules

The run record must never contain:

- Secret values, tokens, or passwords
- Provider identifiers (Telegram chat IDs, etc.)
- Host-specific private paths or IPs
- Raw session dumps or OpenClaw runtime context
- Raw command stdout/stderr output
- Broker edge secrets or API keys

Secret locations may be referenced only by path or handling rule.

### 9.3 Output location

The run record is written to:

- Stdout (always, for immediate operator inspection)
- `/work/artifacts/dispatch-run-record.json` (when running inside the docker runner)
- Optionally to a local file specified by `--output <path>`

## 10. Finalizer closeout handoff

### 10.1 Closeout trigger

When all lanes have reached a terminal state (done, pr, blocked, or cancelled),
the finalizer (`broker-alpha`) is responsible for parent-round closeout.

### 10.2 Handoff packet

The wrapper emits a closeout handoff packet containing:

```json
{
  "$schemaVersion": "a2a.team1.closeout-handoff.v1",
  "parentRoundId": "<runId>",
  "runRecordPath": "/work/artifacts/dispatch-run-record.json",
  "laneStatuses": {
    "worker-gamma": { "status": "pr", "evidenceUrl": "https://github.com/.../pull/N" },
    "worker-beta": { "status": "done", "evidenceUrl": "..." },
    "worker-alpha": { "status": "pr", "evidenceUrl": "..." },
    "worker-delta": { "status": "done", "evidenceUrl": "..." }
  },
  "closeoutRequired": true,
  "closeoutUrl": "https://github.com/jinwon-int/a2a-broker/issues/847",
  "finalizerId": "broker-alpha",
  "aggregateDecision": "WAITING"
}
```

### 10.3 Finalizer responsibilities

The finalizer (`broker-alpha`) must:

1. Review all lane evidence (PR URLs, Done comments, Block reasons).
2. Run the [parent-round closeout go/nogo matrix](#11-closeout-go-nogo-matrix).
3. Post the aggregate Go/No-Go decision on the parent issue.
4. Close the parent issue if Go, or document blockers if No-Go.
5. Ensure no unapproved live-impact actions occurred.
6. Verify runtime/bootstrap hygiene on all branch diffs and artifacts.

### 10.4 Finalizer of record

`broker-alpha` is the broker/finalizer of record for all Team1 parent rounds.
No other entity may close the parent issue or render the aggregate decision.

## 11. Closeout go/nogo matrix

| # | Gate | Required condition | Evidence source | Fail-closed |
|---|---|---|---|---|
| G1 | All lanes terminal | Every lane has reached `done`, `pr`, `blocked`, or `cancelled` | Broker `/tasks` query, lane issue comments | Block if any lane non-terminal |
| G2 | Evidence completeness | Every terminal lane has PR URL, Done comment, or Block comment | Lane issue inspection | Block if missing |
| G3 | Parent metadata preserved | Run record confirms parentRoundId, totals, origin/parent broker | Run record, lane issue bodies | Block if mismatch or missing |
| G4 | No live-impact leak | No unapproved deploy, restart, provider send, DB mutation, ACK, release | Lane evidence, safetyConfirmation block | Block if any detected |
| G5 | Runtime/bootstrap hygiene | Branch diffs exclude deny-list paths | Pre-PR guard, artifact inspection | Block if files found |
| G6 | No false success | No generic handler accepted pattern | Broker task resultSummary | Block if generic accepted |
| G7 | Redacted evidence | No secrets, private paths, raw dumps in evidence | Run record, lane comments | Block if secret-like values |
| G8 | Approval separation | No evidence entry claims approval authority | Issue comment review | Block if approval claimed |
| G9 | Finalizer of record | Only `broker-alpha` may close | Closeout comment | Block if non-broker-alpha close |

### 11.1 Aggregate decision

| ALL gates pass | `GO` — close parent issue, record closeout evidence |
|---|---|
| One or more fails (no unsafe) | `NO_GO` — document blockers, wait for resolution |
| Unsafe condition detected | `BLOCKED` — escalate to operator, do not close |

## 12. Safety confirmation

This runbook documents the Team1 dispatch-wrapper contract for source-only parent-round
dispatch. It does not authorize:

- Production deployment or Gateway/broker/worker restart
- Live provider/Telegram canary or notification send
- Production DB mutation, prune, or migration
- Terminal-outbox ACK or replay
- Historical outbox replay
- Release, tag, or npm publish
- Credential movement or secret value disclosure
- Repository visibility change
- History rewrite or force-push

Evidence at each lane is provider send-acceptance only and does not prove
read, visibility, terminal ACK, or operator approval.

## 13. Related documents

- [Parent-round closeout go/nogo runbook](../a2a-parent-round-closeout-go-nogo/runbook.md)
- [Parent-round dispatch guardrails (validation)](../../validation/team1-source-parent-round-dispatch-guardrails-libero.md)
- [Broker handoff protocol](../../../contracts/a2a/broker-handoff-protocol.md)
- [Task lifecycle contract](../../../contracts/a2a/task-lifecycle.md)
- [Terminal semantics](../../../contracts/a2a/terminal-semantics.md)
- [Docker runner README](../../../packages/docker-runner/README.md)

# Team1/yukson DB lifecycle cleanup GO/NO-GO matrix

Issue: a2a-plane#265 (a2a-plane#265, internal tracker private)
Parent: [a2a-broker#519](https://github.com/jinwon-int/a2a-broker/issues/519)
Linked trackers: [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497), [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294), a2a-plane#75 (a2a-plane#75, internal tracker private)
Worker: `yukson` / Team1
Snapshot: `2026-05-12`

This is a no-live Plane decision artifact for the replacement cleanup API / safe-prune lane. It defines when DB lifecycle cleanup work can move from design and dry-run evidence to deploy/canary/cleanup execution. It does not perform a production DB mutation, prune, migration, deploy, restart, live provider send, terminal ACK, secret change, release, force-push, or repository visibility action.

## Current decision

**Decision: `NO-GO / Waiting`.** The cleanup API and safe-prune lane may continue as source PRs, tests, fixtures, dry-run reports, and redacted docs. Real broker cleanup remains blocked until every GO gate below has linked evidence and a separate operator approval names the exact action.

## Evidence inputs

- `a2a-broker#497` records broker hot-table state growth, multi-GiB RSS after restart, SQLite/WAL state, terminal-outbox backlog, and the need for bounded memory, retention/reaper policy, outbox hygiene, and load/soak tests.
- `a2a-broker#294` requires fail-closed receipt semantics, queue hygiene, canary gates, and explicit approval before production deploy, Gateway/broker/worker restart, live provider send, DB mutation, or terminal-outbox ACK.
- `a2a-plane#75` keeps public-readiness and Terminal Brief activation separate from provider accepted-send evidence; accepted-send is not terminal ACK/read/visibility proof.
- `a2a-broker#519` scopes this round as no-production-mutation design/PR work. Any real DB cleanup remains blocked pending separate explicit approval after backup and dry-run evidence.

## Cleanup lifecycle GO/NO-GO matrix

| Gate | Current status | Required for GO | Fail-closed / NO-GO trigger |
| --- | --- | --- | --- |
| G1. Cleanup API contract | `NO-GO / Waiting` for execution; source design may proceed. | The cleanup API describes target tables/entities, retention windows, tombstone/outbox semantics, idempotency keys, and read-only preview output without making prune the default path. | API can delete or compact production state without dry-run, without explicit target selection, or without idempotent/replay-safe semantics. |
| G2. Safe-prune dry-run evidence | `NO-GO / Waiting`. No current linked dry-run packet is sufficient to authorize cleanup. | Redacted dry-run output lists candidate rows/counts by class, excludes active/queued/running tasks, separates acked vs unacked terminal-outbox rows, and records the exact revision/config used. | Missing dry-run, unbounded row selection, raw payload/session dumps, or any report that treats provider accepted-send evidence as terminal ACK/read/visibility. |
| G3. Backup and restore proof | `NO-GO / Waiting`. | A fresh backup exists for the target DB, has checksum/path recorded in private operator evidence, and a restore or integrity check is proven before prune. Public evidence may reference a redacted backup proof but must not expose host-private paths or secrets. | No backup, stale backup, unverified backup, backup evidence leaks private paths/secrets, or cleanup is bundled with a migration without a rollback point. |
| G4. Deploy and canary evidence | `NO-GO / Waiting`. | Any cleanup-capable build is deployed only after explicit approval; pre/post `/health`, worker capacity, queue state, table counts, outbox ack/unacked counts, heap/RSS, and a no-live or separately approved one-event canary are captured. | Deploy/restart occurs from this lane, canary mutates terminal ACKs, provider send is used as receipt proof, or post-deploy state cannot be compared to pre-deploy evidence. |
| G5. Queue/outbox safety | `NO-GO / Waiting`. | Active/queued/claimed/running tasks are below the approved threshold; unacked terminal-outbox rows are preserved, quarantined by exact allowlist, or handled by an approved policy that never forges ACK from accepted-send evidence. | Cleanup touches active work, drops unacked rows without policy, resets retry/receipt state unsafely, or hides current post-cutoff receipt gaps. |
| G6. Rollback and abort plan | `NO-GO / Waiting`. | Runbook defines abort triggers, rollback steps, evidence to collect on skip/fail, and owner decision points. Abort must win over continuing prune when health, queue, dry-run, backup, or canary evidence is missing or stale. | No rollback owner, no abort criteria, cleanup continues after health/readiness degradation, or failure handling relies on manual memory of raw terminal/session logs. |
| G7. Approval boundary | `NO-GO / Waiting`. | A separate operator approval explicitly names the action: deploy/restart, dry-run against production DB, prune/mutation, migration, live provider send, terminal ACK, secret change, release, or force-push. | Inferring approval from a merged PR, passing tests, issue assignment, Start/Done evidence, provider accepted-send, or a bundled approval-and-execute comment. |
| G8. Runtime/bootstrap artifact hygiene | `PASS only if final diff/evidence stays clean`. | `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` are absent from branch changes, PR/Done/Block evidence, and artifact bundles. | Any guard path or raw session/runtime dump enters the branch, PR body, issue comment, or artifact evidence. |

## Minimum evidence bundle before any real cleanup

1. Source PR for cleanup API / safe-prune behavior with focused tests and no production mutation.
2. Dry-run report from the candidate build showing exact retention classes and row counts, with active work and unacked terminal-outbox handling separated.
3. Backup proof with checksum/integrity or restore check recorded in private operator evidence and redacted public summary.
4. Deploy/canary packet: pre/post health, queue, worker, table, outbox, WAL, heap/RSS, and canary evidence, with accepted-send labeled non-ACK.
5. Rollback/abort packet naming owner, time window, skip conditions, restore path, and post-abort verification.
6. Explicit operator approval for each live-impact action; approval cannot be inferred from this document or from CI.

## Safe closeout language for this lane

Safe PR/Done evidence may say: **the DB lifecycle cleanup GO/NO-GO matrix is documented, source-only cleanup API/safe-prune work may proceed, and production cleanup remains `NO-GO / Waiting`.** It must not claim authorization for DB cleanup, backup completion, deploy/canary approval, provider accepted-send as terminal receipt, or public-readiness completion.

## Validation commands

Recommended validation for this artifact:

```bash
node --test scripts/archive/check-team1-yukson-db-lifecycle-cleanup-go-nogo.test.mjs
npm run scan:public-readiness
```

Before PR/Done/Block evidence, fail closed if any runtime/bootstrap guard path appears in branch changes or artifacts:

```bash
git status --short -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw
git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw
```

## Safety confirmation

This matrix used docs, public issue metadata, and no-live analysis only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production DB mutations, DB prune/migration, terminal-outbox ACKs, secret rotations/disclosures, repository visibility changes, release publication, history rewrites, force-pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.

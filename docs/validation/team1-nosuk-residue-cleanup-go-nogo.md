# Team1/nosuk residue cleanup GO/NO-GO matrix

Issue: [a2a-plane#397](https://github.com/jinwon-int/a2a-plane/issues/397)  
Parent: [a2a-broker#835](https://github.com/jinwon-int/a2a-broker/issues/835)  
Linked trackers: [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294), [a2a-broker#342](https://github.com/jinwon-int/a2a-broker/issues/342), [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497), [a2a-broker#519](https://github.com/jinwon-int/a2a-broker/issues/519), [a2a-plane#75](https://github.com/jinwon-int/a2a-plane/issues/75)  
Worker: `nosuk` / Team1  
Lane: 4/4  
Parent round: `a2a-team1-residue-outbox-cleanup-20260520T124743Z`  
Snapshot: `2026-05-20`

This is a no-live Plane decision artifact for the residue/outbox cleanup policy. It defines when terminal-outbox legacy residue and current post-cutoff receipt gaps can transition from read-only scan and dry-run evidence to operator-approved cleanup action. It does not perform a production DB mutation, prune, migration, deploy, restart, live provider send, terminal ACK, historical outbox replay, Gateway/plugin restart, secret change, release, force-push, or repository visibility action.

### Background: legacy residue vs current gaps

The broker terminal-outbox retains terminal task lifecycle events (`task.succeeded`, `task.failed`, `task.canceled`) for notifier consumption. The `legacyResidueCutoff` (`2026-05-04T07:10:00.000Z`) divides outbox rows into two classes:

| Class | Definition | Policy treatment |
| --- | --- | --- |
| **Legacy residue** | Created before cutoff; no receipt-confirmed ACK evidence | Quarantined for bounded exception window; reported but does not block release gate or one-shot live eligibility during the quarantine. After quarantine expiry (`2026-05-11T07:10:00.000Z`), legacy residue must be explicitly handled or makes the migration gate fail. |
| **Current post-cutoff gap** | Created at or after cutoff; no receipt-confirmed ACK evidence | Blocks release gate, blocks one-shot live eligibility. Must be resolved through normal operator-visible/provider-delivery receipt ACK path before cleanup can proceed. |

The residue cleanup GO/NO-GO matrix covers both classes. Legacy residue may require separate operator approval that names the exact cleanup action (quarantine, explicit ACK with operator-visible evidence, or retention-eviction after the quarantine window). Current post-cutoff gaps cannot be treated as residue; they must follow the normal terminal-outbox ACK lifecycle.

## Current decision

**Decision: `NO-GO / Waiting`.** The residue/outbox cleanup policy and go/no-go matrix may proceed as source PRs, tests, fixtures, dry-run reports, and redacted docs. No real cleanup action — DB mutation, prune, terminal ACK, historical outbox replay, or live provider canary — is authorized until every GO gate below has linked evidence and a separate operator approval names the exact action.

## Evidence inputs

- `a2a-broker#835` scopes this round as a no-production-mutation policy/spec PR. Any real residue cleanup or terminal-outbox mutation remains blocked pending separate explicit approval after backup, dry-run evidence, and operator approval.
- `a2a-broker#294` requires fail-closed receipt semantics, queue hygiene, canary gates, and explicit approval before production deploy, Gateway/broker/worker restart, live provider send, DB mutation, or terminal-outbox ACK.
- `a2a-broker#342` captures the closeout-receipt matrix and release-gate pre-cut verification with legacy-residue quarantine policy.
- `a2a-broker#497` records broker hot-table state growth, multi-GiB RSS after restart, SQLite/WAL state, terminal-outbox backlog, and the need for bounded memory, retention/reaper policy, outbox hygiene, and load/soak tests.
- `a2a-broker#519` scopes DB lifecycle cleanup as no-production-mutation design/PR work; legacy residue cleanup inherits the same boundary.
- `a2a-plane#75` keeps public-readiness and Terminal Brief activation separate from provider accepted-send evidence; accepted-send is not terminal ACK/read/visibility proof.

## Residue cleanup GO/NO-GO matrix

| Gate | Current status | Required for GO | Fail-closed / NO-GO trigger |
| --- | --- | --- | --- |
| G1. Residue scan contract (read-only) | `NO-GO / Waiting` for execution; source policy and scan spec may proceed. | The read-only residue scan script describes: target outbox table/fields, legacy-residue vs current-gap classification, retention/tombstone state, idempotent preview output, and a strict no-write, no-ACK, no-notifier-send mode. Must pass `--no-live`, `--json`, `--dry-run` flags. | Scan mutates, ACKs, notifies, or deletes production state without dry-run, without explicit target selection, or without read-only semantics enforced at script level. |
| G2. Dry-run residue report | `NO-GO / Waiting`. No current linked dry-run packet is sufficient to authorize any cleanup action. | Redacted dry-run output lists legacy residue rows and current post-cutoff gaps separately, excludes active/queued/running tasks, separates acked vs unacked terminal-outbox rows, records the exact revision/config used, and proves that accepted-send evidence is never confused with terminal ACK/visibility. | Missing dry-run, unbounded row selection, raw payload/session dumps, provider-send-only evidence treated as ACK, or any report that claims operator visibility from send evidence alone. |
| G3. Backup and restore proof | `NO-GO / Waiting`. | A fresh backup exists for the target broker DB, has checksum/path recorded in private operator evidence, and a restore or integrity check is proven before any prune/migration. Public evidence may reference a redacted backup proof but must not expose host-private paths or secrets. For legacy residue quarantine expiry, backup must prove the terminal-outbox table state at expiry timestamp. | No backup, stale backup, unverified backup, backup evidence leaks private paths/secrets, or cleanup is bundled with a migration without a rollback point. |
| G4. Operator-approved action plan | `NO-GO / Waiting`. | The operator approval explicitly names: which action (prune, ACK legacy residue, evict-by-retention, migration, noop) is approved, the exact rows/IDs/classes affected, the bound on rows touched, the read-only preview command to run first, the rollback command, and the post-action verification query. Approval cannot be inferred from a merged PR, passing CI, issue assignment, or Start/Done evidence markers. | No operator approval, approval names a different action, approval bundles multiple actions without per-action evidence, action touches active/queued/running tasks, or approval predates the backup/dry-run evidence by more than one business day. |
| G5. Terminal-outbox ACK boundary | `NO-GO / Waiting`. No terminal-outbox ACK of any legacy residue row is authorized without explicit operator approval that names each stable event ID and the exact receipt evidence. | Every legacy residue row proposed for ACK has: stable `id`/`taskEventId`, creation timestamp, terminal status, current receipt status, and a separate operator-visible confirmation. Provider-send-only evidence (`provider_sent`, `provider_accepted`) must never be treated as ACK evidence. The approval must name each row individually or name the exact retention-eviction policy if ACK-by-eviction is used. | Bulk-ACK without per-row evidence, ACK based on provider accepted-send, ACK of rows with active/queued/running task state, or ACK of rows within the post-cutoff gap window without full terminal-outbox ACK cycle. |
| G6. Historical outbox replay safety | `NO-GO / Waiting`. | Any replay of terminal-outbox events after cleanup must be read-only, cursor-based, and must not trigger duplicate notifier sends, Telegram pushes, or operator notifications. The replay mechanism must prove `providerCalled=false` and `productionAckAttempted=false` before and after the replay. Re-driven outbox rows from a replay must be labeled with a clear `replayed: true` provenance and must never be automatically ACKed. | Replay triggers live notifications, replay mutates ACK state, replay skips provenance labeling, or replay is used to infer operator-visibility from provider-send-only evidence. |
| G7. Legacy residue quarantine expiry | `NO-GO / Waiting`. Operators must decide before `2026-05-11T07:10:00.000Z` whether to: (a) extend the quarantine with documented rationale, (b) ACK individual rows via operator-visible evidence and the normal terminal-outbox ACK path, (c) retain-and-evict by letting retention max (default 1000) rotate them out, or (d) prune quarantined rows after operator approval and backup. After expiry, the migration health gate fails if any legacy residue remains unhandled. | No operator decision recorded, quarantine auto-extended without rationale, or operator approves prune/ACK without separate backup and dry-run evidence. |
| G8. Stale worker and backlog reporting | `NO-GO / Waiting`. The residue cleanup report must distinguish stale-worker-registered outbox rows from non-stale ones. Stale worker backlog must not be attributed to active workers and must not be used as evidence of live-terminal-outbox-health or one-shot-live-eligibility. | Residue report conflates stale-worker backlog with active-worker state, uses stale-worker backlog to claim one-shot live eligibility, or backfills terminal-ACK from stale-worker rows without operator approval naming each row. |
| G9. Rollback and abort plan | `NO-GO / Waiting`. | Runbook defines abort triggers (unexpected row count, health degradation, backup mismatch), rollback steps (restore DB, revert known-acked cursor, notify operator of restored state), evidence to collect on skip/fail, and owner decision points. Abort must win over continuing cleanup when health, queue, dry-run, backup, or canary evidence is missing or stale. | No rollback owner, no abort criteria, cleanup continues after health/readiness degradation, or failure handling relies on manual memory of raw terminal/session logs. |
| G10. Runtime/bootstrap artifact hygiene | `PASS only if final diff/evidence stays clean`. | `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` are absent from branch changes, PR/Done/Block evidence, and artifact bundles. | Any guard path or raw session/runtime dump enters the branch, PR body, issue comment, or artifact evidence. |

## Minimum evidence bundle before any real cleanup action

1. Source PR for residue cleanup policy matrix with focused tests and no production mutation.
2. Read-only residue scan script that classifies rows into legacy residue and current post-cutoff gaps without ever calling the notifier, mutating SQLite, or ACKing rows.
3. Dry-run report from the scan showing exact legacy residue and current-gap counts, with active work and unacked terminal-outbox handling separated.
4. Backup proof with checksum/integrity or restore check recorded in private operator evidence and redacted public summary.
5. Operator-approved action plan naming per-row or per-class cleanup actions, with explicit mention of forbidden inference from accepted-send evidence.
6. Rollback/abort packet naming owner, time window, skip conditions, restore path, and post-abort verification.
7. Explicit operator approval for each live-impact action; approval cannot be inferred from this document or from CI.

## Safe closeout language for this lane

Safe PR/Done evidence may say: **the residue cleanup GO/NO-GO matrix is documented, source-only residue scan and policy work may proceed, and no cleanup action — DB mutation, terminal-outbox ACK, historical replay, or live provider canary — is authorized.** It must not claim authorization for residue ACK, DB prune/migration, backup completion, deploy/canary approval, provider accepted-send as terminal receipt, or public-readiness completion.

## Validation commands

Recommended validation for this artifact:

```bash
node --test scripts/check-team1-nosuk-residue-cleanup-go-nogo.test.mjs
npm run scan:public-readiness
```

Before PR/Done/Block evidence, fail closed if any runtime/bootstrap guard path appears in branch changes or artifacts:

```bash
git status --short -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw
git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw
```

## Safety confirmation

This matrix used docs, public issue metadata, and no-live analysis only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production DB mutations, DB prune/migration, terminal-outbox ACKs, historical outbox replay, secret rotations/disclosures, repository visibility changes, release publication, history rewrites, force-pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.

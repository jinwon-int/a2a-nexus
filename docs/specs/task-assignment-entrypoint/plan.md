# Implementation Plan: Task Assignment Entrypoint (#2187 Phase A+B)

## Baseline

- Source baseline: `main@f0618d127958b788cb6abda623d9ad89d18addd4` (the
  revision the issue verified).
- Reuse-first: no new top-level script, no new npm script, no broker runtime
  change. Only additive changes to existing validated modules.

## Phases

### Phase A — spec & reuse plan (this PR)

1. `docs/specs/task-assignment-entrypoint/{spec,plan,tasks}.md` written
   against the verified baseline; reuse table maps every touched asset.
2. Contract decisions fixed: library facade (no CLI), state set, digest
   boundary, journal layout, TTL default, retry budget, nextAction allowlist.

### Phase B — source (this PR)

1. `scripts/lib/task-assign-entrypoint.mjs`:
   - normalization with batched missingFields + untrusted-field rejection;
   - canonical spec digest (sha256 over sorted-key JSON);
   - `TaskAssignJournal` (0700 dir / 0600 files, tmp+rename+fsync atomic
     writes, symlink rejection, first-write-wins init, per-request lock with
     stale-lock recovery);
   - `collectReadiness` (live GET /workers read-only adapter; offline
     snapshot with TTL) + trusted-record merge;
   - deterministic `selectWorker` with recorded rationale and per-worker
     exclusion reasons; patch screening mirror of #1034/#1597 (non-authoritative);
   - versioned lane templates → dispatcher-shaped manifest;
   - `prepareAssignment` / `submitAssignment` / `resumeAssignment` with the
     state machine, readback recovery, bounded retry, and receipt assembly;
   - S1 timeline with host-vs-tool clock separation.
2. `scripts/a2a-dispatch-round.mjs`: ADDITIVE only — failed classifications
   may carry `retryAfterMs` (capped 30 s) parsed from `Retry-After`. The
   dispatcher itself still performs zero retries; existing exports and
   behavior unchanged.
3. Tests: `scripts/lib/task-assign-entrypoint.test.mjs` (in-process mock
   broker; covers the issue's mandatory regression scenarios) registered in
   `scripts/release-gate-manifest.json`.
4. Docs: `docs/agent-manual.md` gains the programmatic-entrypoint pointer
   (usage-changing PR rule); spec docs linked from the same PR.

### Phase C — wiring & pilot (tracked, NOT this PR)

1. Link the node-side `a2a-task-poll` skill / host integrations to this
   facade without duplicating commands (follow-up task on the owning repos).
2. Host integration must inject `correlation.requestReceivedAt` and the
   trusted context; fixture-level skill existence is not host evidence.
3. Limited live pilot with task IDs, admission readback and comparison
   metrics — requires separate operator approval; holdout design fixed
   BEFORE measurement (issue §5). Success target candidate: one agent call
   for a complete well-formed request; zero input-contract re-submissions.

## Risks & mitigations

- **Mirror drift** between the selection screen and the dispatcher gates:
  the dispatcher's `validateManifest` remains the final authority; the mirror
  only avoids selecting obviously-ineligible candidates. Tested both ways.
- **Journal corruption**: corrupt records fail closed (conflict on write,
  explicit state on resume) instead of silent re-initialization.
- **False success reporting**: every ambiguous path maps to
  `admission_unconfirmed`/`existing(unverified)`, never `admitted`.

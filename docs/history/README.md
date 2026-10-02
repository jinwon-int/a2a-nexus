# A2A Nexus history index

Completed migration, canonical-source, and rehearsal records are separated from the living operator surface here.

The staged monorepo migration (split repos → canonical `packages/*`) finished, and
the fourteen per-stage packets that recorded its preflights, handoffs, sign-offs
and execution results were retired along with the release-gate steps that pinned
them. `current-state.md` is the record of the resulting topology; the re-entry
decision below is kept because the docs-routing gate still reads it.

| Record | Summary |
| --- | --- |
| [`import-plan.md`](import-plan.md) | Original repository import plan (executed) |
| [`migration.md`](migration.md) | Monorepo migration guide (Phase 0; flip since executed, superseded by current-state.md) |
| [`monorepo-migration-checklist.md`](monorepo-migration-checklist.md) | Monorepo Architecture and Cutover Proof (Historical Reference) |
| [`monorepo-reentry-decision.md`](monorepo-reentry-decision.md) | A2A Monorepo Re-entry Decision |
| [`promotion-validation.md`](promotion-validation.md) | Promotion validation evidence and GO decision (2026-05-08) |
| [`public-alpha-hardening.md`](public-alpha-hardening.md) | Public alpha hardening closeout record (#1163) |
| [`public-externalization-followups.md`](public-externalization-followups.md) | Public externalization follow-up closeout evidence |
| [`public-feedback-intake.md`](public-feedback-intake.md) | Public feedback intake closeout evidence (#1169) |
| [`public-readiness-go-nogo.md`](public-readiness-go-nogo.md) | Public readiness GO/NO-GO record (pre-public-flip) |
| [`public-readiness.md`](public-readiness.md) | Public readiness gate record (flip executed; stub remains at docs/public-readiness.md) |
| [`public-transition-smoke-plan.md`](public-transition-smoke-plan.md) | Public transition smoke plan (transition complete) |
| [`r3-closeout-validation.md`](r3-closeout-validation.md) | R3 Closeout Validation |
| [`r6-terminal-brief-openclaw-routing-synthesis.md`](r6-terminal-brief-openclaw-routing-synthesis.md) | R6 Terminal Brief OpenClaw routing no-bypass synthesis |
| [`release-evidence-v0.1.0-alpha.md`](release-evidence-v0.1.0-alpha.md) | v0.1.0-alpha release evidence packet (#1286, 2026-07-05) |
| [`release-notes-r3.md`](release-notes-r3.md) | R3 Release Notes Draft |
| [`public-source-readiness-audit-2026-05-27.md`](public-source-readiness-audit-2026-05-27.md) | Public source readiness audit (2026-05-27, pre-public-flip) |
| [`warn-log-aggregation-2026-07-v2.md`](warn-log-aggregation-2026-07-v2.md) | V2 warn-log aggregation (2026-07-04) |
| [`codeql-triage-2026-07.md`](codeql-triage-2026-07.md) | CodeQL triage — 2026-07 V1 organic observation round (#1264) |
| [`release-gate-diet-closeout.md`](release-gate-diet-closeout.md) | Release gate diet closeout (#1201; opt-in tiers since removed) |
| [`terminal-brief-sidecar-default-on-inventory.md`](terminal-brief-sidecar-default-on-inventory.md) | Terminal brief sidecar default-on consolidation inventory |
| [`terminal-brief-sidecar-default-on-consolidation.md`](terminal-brief-sidecar-default-on-consolidation.md) | Terminal brief default-on consolidation closeout |

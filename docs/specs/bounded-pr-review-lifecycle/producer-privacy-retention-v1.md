# Review-lineage producer and privacy/retention contract v1

Phase 11 closes the source-contract gate that precedes any automatic
record-mode producer. It is pure and source-only: there is still no completion,
retry, finalizer, provider, GitHub, or HTTP mutation call site.

## Explicit producer facts

`ReviewLineageProducerFactV1` is structured source evidence. It contains a
stable producer/event identity, lineage identity, UTC observation time, exact
intent/head/diff binding, and one complete observation payload.

The compile-time completeness matrix covers exactly:

1. `lineage_create`;
2. `review_report`;
3. `correction_generation`;
4. `reviewer_replacement`;
5. `operator_cancel`.

A producer fact changes only its outer version tag before it enters
`parseReviewLineageObservation`. The Phase 8 parser remains the sole field,
binding, transition, idempotency-key, and payload-fingerprint validation
boundary. No task state, result prose, review sentence, log, provider output,
missing field, or wall clock may be inferred.

Adding another observation kind breaks the mapped completeness declaration
until the producer contract names it explicitly.

## Privacy classes

| Data | Classification | Approved export |
| --- | --- | --- |
| Canonical lineage | restricted sensitive | no |
| Idempotency ledger | internal operational metadata | no |
| Scorecard projection | redacted pseudonymous analytics | approval-bound |

Canonical records may contain frozen goals/non-goals, subject hashes, review
notes, findings and evidence, paths, appeals, and operator detail. The minimized
ledger excludes those bodies but still carries internal linkage and outcome
metadata. Neither is an export format.

The only Phase 11 export proof is the existing scorecard projection. It uses
round-scoped lineage references, numeric metrics, state/terminal reason,
timestamps, unresolved-signature counts, and hashed intent-drift signal
references. It excludes raw lineage IDs, intent/head/diff, findings, notes,
paths, worker/provider identities, and ledger rows.

The scorecard references are pseudonymous, not anonymous. Export remains
approval-bound and round-scoped.

## Retention plan

The pure planner requires all of:

- an explicit versioned approval reference;
- an approved cutoff timestamp;
- an `asOf` timestamp no earlier than that approval;
- canonical records with storage-owned monotonic versions and expected ledger
  counts.

There is no default retention duration and no implicit cutoff.

Only terminal lineages strictly older than the cutoff are candidates:

- `passed`;
- `blocked_needs_operator`;
- `intent_conflict`;
- `canceled`.

Active, unknown, malformed, future-dated, and at-or-after-cutoff records fail
closed or remain excluded.

Every candidate is one `canonical_lineage_plus_ledger` aggregate. The plan
cannot express a canonical-only or ledger-only deletion. It binds the expected
record version, state, update timestamp, ledger count, and corresponding
redacted export reference.

## Export-before-prune

The planner first invokes `buildReviewLineageScorecardInput` and computes a
canonical fingerprint over the validated redacted envelope. Only after that
succeeds does it construct aggregate prune candidates.

This is a proof and plan, not a delivery receipt or deletion command. A later
executor must separately define and receive approval for:

- export delivery/retention completion semantics;
- the jurisdiction-appropriate duration and cutoff;
- one worker-owned command;
- `BEGIN IMMEDIATE` state/version/count revalidation;
- coupled lineage and ledger deletion plus row-count verification;
- deployment, canary, and rollback.

## Source boundary

Phase 11 adds no:

- automatic producer attachment or disabled runtime plumbing;
- task completion, retry, finalizer, GitHub, or provider subscription;
- broker/store/worker queue/HTTP mutation;
- SQL deletion, schema migration, live export, or cohort collection;
- deploy, restart, canary, ACK/replay/prune operation, or provider send;
- `enforce` support, budget-default change, release/tag, credential movement,
  issue closure, or ruleset change.

The real 30-terminal-lineage cohort remains open.

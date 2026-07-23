# Review-lineage explicit producer-fact admission v1

Phase 12 adds the asynchronous admission boundary that must exist before an
automatic record-mode producer can be attached.

It is deliberately not an automatic producer.

## Accepted input

`admitReviewLineageProducerFact` accepts one unknown value at the trust
boundary. In `record` mode it sends that value through
`projectReviewLineageProducerFact`, so the Phase 8 parser remains the sole
field, exact-subject, transition, idempotency-key, and payload-fingerprint
validator.

The admission layer does not inspect or derive facts from:

- task status;
- task result summary, note, or output;
- review prose or logs;
- provider/GitHub output;
- generic task cancellation;
- a missing field or the current wall clock.

The caller must already possess one complete
`ReviewLineageProducerFactV1`. In particular, the caller remains responsible
for assigning an authoritative stable `producerId` and `sourceEventId`.
Structural validation cannot prove that an identifier was assigned by the
correct external source.

## Rollout behavior

### `off`

`off` is still the default. Admission returns `undefined` before parsing the
input or touching the store. An invalid value therefore cannot change default
broker behavior.

### `record`

`record` performs exactly:

1. validate and project the complete producer fact;
2. invoke one `applyReviewLineageObservation` compound command;
3. await its durable result;
4. return the applied, replayed, rejected, or conflict result to the caller.

The production broker continues to refresh its in-memory read projection only
after the canonical store acknowledges the lineage-plus-ledger transaction.
Worker-thread queue saturation, close, abort, crash, and database errors remain
observable Promise rejections. No Promise is detached or downgraded.

## Completion and cancellation boundary

The existing synchronous `completeTask`, `failTask`, and `cancelTask` methods
do not call admission.

This is required because:

- their many HTTP and non-HTTP callers currently rely on synchronous terminal
  semantics;
- the canonical review-lineage store may be an asynchronous worker-thread
  queue;
- fire-and-forget would hide queue or database failure;
- generic terminal state lacks a complete exact-bound producer fact;
- a rejected review verdict throws before task success and cannot be recovered
  honestly from terminal status;
- generic or recursive cancellation is not evidence of a review-lineage
  `operator_cancel`.

Record-mode lineage admission therefore cannot turn a successful task into a
later failure, and it cannot acknowledge a task while silently losing a
lineage write, because the two paths are not yet coupled.

## Automatic coverage

Automatic source coverage remains `0/5`.

The Phase 11 completeness matrix proves which shapes are allowed. It does not
prove that an authoritative runtime source emits:

1. `lineage_create`;
2. `review_report`;
3. `correction_generation`;
4. `reviewer_replacement`;
5. `operator_cancel`.

A future attachment phase must enable kinds individually and prove, for each
kind:

- the dispatcher- or engine-owned structured source;
- stable source-event identity;
- exact intent/head/diff binding;
- preservation of rejected review evidence when applicable;
- durable coupling or an atomic outbox boundary;
- replay/restart behavior;
- no change to task completion semantics.

## Source-only boundary

Phase 12 adds no task lifecycle hook, result carrier, HTTP mutation route,
outbox/schema/table, producer subscription, live data collection, export,
prune, deploy, restart, canary, provider send, `enforce` mode, default change,
release, credential movement, issue closure, merge, or ruleset change.

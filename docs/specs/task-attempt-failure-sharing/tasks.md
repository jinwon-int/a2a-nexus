# Tasks: Task Attempt Failure Sharing V1

Refs #1635.

## This source-only slice

- [x] Define closed `TaskAttemptRecordV1` broker and experiment variants.
- [x] Keep broker outcomes disjoint from experiment dispositions.
- [x] Define opaque public-safe identity and retry semantics.
- [x] Define stable bounded reason class/code vocabularies.
- [x] Pin canonical JSON, byte framing, digest domains, keys, and fingerprints.
- [x] Define idempotent replay and same-key/different-payload conflict.
- [x] Define failure-channel and dispatcher preflight as advisory views only.
- [x] Define fail-closed boundary behavior with no task-execution effect.
- [x] Add the single public synthetic fixture and deterministic checker.
- [x] Register the checker in the existing conformance runner.

## Explicitly deferred

- [ ] Admit a runtime broker-execution producer.
- [ ] Admit a runtime bounded-experiment producer.
- [ ] Add a consumer, route, exchange write, or dispatcher read.
- [ ] Add a store, database schema, migration, or persistence.
- [ ] Add dispatcher enforcement, claim denial, or automatic dispatch policy.
- [ ] Add automatic retry or finalizer integration.
- [ ] Change existing `TaskRecord`, broker exchange, or task-lineage behavior.
- [ ] Complete or close #1635.

Deferred work requires a separate scoped change and approval.

# Plan: Task Attempt Failure Sharing V1

Refs #1635. See [the contract](./spec.md) and
[clarifications](./clarify.md).

## Phase 1 — Source-only contract

- Freeze the two producer domains and their disjoint result vocabularies.
- Freeze public-safe identity grammars, retry-root/ordinal semantics, reason
  enums, canonical framing, digest domains, replay, and conflict behavior.
- Freeze the read-only exchange and dispatcher projections.

Exit gate: documentation is internally consistent and grants no runtime
authority.

## Phase 2 — Golden conformance

- Add one closed synthetic fixture with the exact required positive and
  negative cases.
- Add one deterministic checker using Node.js built-ins only.
- Register it in the existing conformance runner without adding a root script.
- Verify canonical digests, closed shapes, cross-field domain separation,
  ordering, bounds, replay, conflicts, and advisory-only effects.

Exit gate: focused and aggregate conformance pass with no network access.

## Phase 3 — Future producer admission, not part of this slice

A future change may propose an explicit producer only after it proves:

- public-safe identifier assignment is not derived from private data;
- the producer can emit its claimed result vocabulary directly;
- immutable broker-of-record and retry identity;
- boundary rejection cannot change task execution;
- no raw/private material can enter records or views.

That work requires a separate issue/PR and does not retroactively classify
existing broker attempts.

## Phase 4 — Future integration, not approved

Routes, storage, migrations, exchange writes, dispatcher reads, automatic
retry, enforcement, and live policy are separate work. Nothing in this plan
authorizes them.

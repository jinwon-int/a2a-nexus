# Review-lineage authoritative source carrier v1

Phase 13 defines the source-only authority boundary that must exist before an
automatic producer can be attached.

It does not create an authenticated runtime owner or an automatic producer.
Automatic observation coverage remains `0/5`.

## Trust separation

`ReviewLineageSourceCarrierV1` is serializable untrusted input. Its exact fields
are:

- versioned carrier kind;
- source kind;
- immutable source-local event reference;
- lineage ID and observed timestamp;
- exact intent/head/diff binding;
- one complete observation payload.

The carrier cannot contain:

- `producerId`;
- `sourceEventId`;
- an authority or issuer claim;
- task status, result prose, provider output, logs, or generic cancellation;
- additional fields.

Authority is supplied separately as a process-local
`ReviewLineageTrustedSourceContextV1`. Only
`createReviewLineageTrustedSourceContext` can issue a context accepted by the
authorization function; cloning or reconstructing the visible fields does not
recreate the capability.

The factory does not authenticate an actor by itself. Calling it is a
trusted-code operation reserved for a future boundary that has already
authenticated the dispatcher, reviewer, controller, allocator, or operator.
Phase 13 adds no such caller.

## Per-kind authority matrix

| Observation | Immutable source event | Required authority |
| --- | --- | --- |
| `lineage_create` | `lineage_contract_frozen` | `lineage_dispatcher` |
| `review_report` | `review_report_submitted` | `reviewer` |
| `correction_generation` | `correction_generation_committed` | `correction_controller` |
| `reviewer_replacement` | `reviewer_replacement_decided` | `reviewer_allocator` |
| `operator_cancel` | `lineage_cancel_decided` | `operator` |

The matrix is keyed by every `ReviewLineageObservationV1` kind. Adding a kind
therefore fails compilation until its source event and authority class are
named.

For `review_report`, the trusted issuer must also equal
`receipt.reviewerNodeId`. A generic worker result, validation summary, task
completion, or task cancellation is not a substitute for the complete source
event.

## Derived identity

Neither identity is caller-selected.

`producerId` is:

```text
review-lineage-source:v1:
  sha256(canonicalJson({
    authorityKind,
    issuerId,
    sourceNamespace,
    version: 1
  }))
```

`sourceEventId` is:

```text
review-lineage-event:v1:
  sha256(canonicalJson({
    producerId,
    sourceEventRef,
    sourceKind,
    version: 1
  }))
```

The source event ID deliberately excludes the observation payload and lineage
subject. Reusing one immutable source reference with changed evidence keeps
the same idempotency key while changing the canonical payload fingerprint, so
the existing ledger reports an idempotency conflict instead of accepting a
second meaning for one event.

Different issuers, namespaces, source kinds, or immutable references produce
different identities.

## Canonical projection boundary

Authorization validates only:

- exact carrier fields and version;
- immutable reference syntax;
- source-kind-to-observation mapping;
- trusted-context authority;
- reviewer issuer identity.

It then constructs `ReviewLineageProducerFactV1` and delegates complete field,
subject, transition, idempotency, and fingerprint validation to the existing
Phase 11 fact builder and Phase 8 parser.

A future runtime owner must pass the returned fact to the existing Phase 12
`admitReviewLineageProducerFact` API. It must not add another parser, store
command, or Map-first mutation.

## Durable attachment gate

An actual source kind remains blocked until its owner proves either:

1. one transaction commits the authoritative source event and the canonical
   lineage-plus-idempotency-ledger command; or
2. the source transaction also writes a transactional outbox/inbox record
   keyed by the derived source identity, and a durable consumer replays it
   until admission ACK.

Awaiting two independent writes is not atomic. Fire-and-forget is not durable.
A successful task followed by an uncommitted lineage write is not acceptable.

The first automatic kind must additionally prove:

- the exact authenticated owner and context-construction call site;
- stable source namespace and event reference assignment;
- failed-review preservation where applicable;
- replay and restart behavior;
- no change to task completion semantics.

## Source-only boundary

Phase 13 adds no broker/store/task/cancellation/finalizer/HTTP call site,
outbox/table/schema/migration, source subscription, queue consumer, live
collection, deploy, restart, canary, provider send, export/prune, default
change, release, credential movement, issue closure, merge, or ruleset change.

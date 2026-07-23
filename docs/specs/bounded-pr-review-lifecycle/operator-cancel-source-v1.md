# Authenticated review-lineage operator cancel source v1

Phase 14 attaches the first actual authoritative observation kind:
`operator_cancel`. Automatic source coverage becomes exactly `1/5`.

This is a source implementation and test boundary. It does not enable record
mode by default or approve live schema execution, migration, deployment,
restart, canary, or real-lineage collection.

## Authenticated owner and request

The owner is the requester authenticated by the broker edge and carrying the
exact `operator` role. The only mutation path is:

```text
POST /review-lineages/{lineageId}/operator-cancel
```

The request body has exactly:

- `decisionRef`: immutable operator-decision reference;
- `observedAt`: UTC observation time;
- `binding`: exact `intentHash`, `headSha`, and `diffHash`;
- `detail`: bounded cancellation explanation.

Unknown or missing fields fail closed. The request cannot carry `sourceKind`,
`authorityKind`, `producerId`, `sourceEventId`, issuer, or source namespace.
The mutation route requires operator identity even when legacy requester
enforcement is relaxed for other routes.

## Canonical authorization chain

After the role gate, trusted broker code fixes:

- source kind: `lineage_cancel_decided`;
- authority kind: `operator`;
- source namespace: `broker-http:review-lineage-operator-cancel:v1`;
- issuer: authenticated requester ID.

It then uses the existing Phase 13 trusted-context and carrier authorization,
the Phase 12 producer-fact admission function, and the Phase 8 parser. No
second subject, transition, idempotency, or fingerprint parser is introduced.
Generic `cancelTask`, recursive task cancellation, task completion, retry, and
finalizer paths remain detached.

## Atomic source admission

Schema version 13 adds:

```text
broker_review_lineage_authorized_source_events_v1
```

One `BEGIN IMMEDIATE` transaction performs:

1. authoritative source-event replay/conflict lookup;
2. canonical observation-ledger replay/conflict lookup;
3. exact lineage subject comparison and lifecycle transition;
4. canonical lineage and observation-ledger write;
5. minimized authoritative source-event write;
6. commit or full rollback.

The source row stores only derived IDs, source/authority class, a hash of the
immutable local reference, canonical payload fingerprint, observation time,
and stable outcome. It does not store the raw request, decision reference,
detail, prompts, credentials, provider output, or production payloads.

The broker refreshes its read projection only after the composite durable ACK.
Worker-thread persistence sends one composite command and returns one ACK; it
does not split source and lineage writes.

## Replay and conflict

The same operator, namespace, source kind, and immutable decision reference
derive the same event identity after restart.

- Same identity and same canonical fingerprint replays the stored outcome
  without another transition.
- Same identity with changed detail, binding, timestamp, or other canonical
  evidence returns an idempotency conflict without overwrite.
- A generic ledger row cannot be retroactively upgraded into an authenticated
  source row.
- A source/ledger inconsistency fails as corrupted stored state.

## Rollout and safety boundary

`A2A_REVIEW_LINEAGE_MODE=off` returns before request validation, trusted
context construction, or store access. `record` is still the only active mode;
`enforce` remains unsupported.

Phase 14 adds no automatic owner for `lineage_create`, `review_report`,
`correction_generation`, or `reviewer_replacement`. It changes no task outcome,
approval, retry, finalizer, GitHub, provider, release, or deployment behavior.

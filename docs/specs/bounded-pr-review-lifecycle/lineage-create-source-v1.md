# Authenticated review-lineage create source v1

Phase 15 attaches the second authoritative observation kind:
`lineage_create`. Automatic source coverage becomes exactly `2/5`.

This is a source implementation and temporary-database test boundary. It does
not enable record mode by default or approve live schema execution, migration,
deployment, restart, canary, or real-lineage collection.

## Normative owner and request

The bounded-lifecycle spec makes the operator the only actor who may start a
new lineage or adjust intent. The mutation path is:

```text
POST /review-lineages
```

The edge-authenticated requester must carry the exact `operator` role. The
request body has exactly:

- `dispatchRef`: immutable contract-freeze reference;
- `observedAt`: UTC observation time;
- `binding`: exact `intentHash`, `headSha`, and `diffHash`;
- `contract`: complete `IntentContractV1`;
- `budget`: complete `ReviewLineageBudgetV1`.

The lineage ID comes from `contract.lineageId`. The canonical Phase 8 parser
cross-checks it and the intent/head binding. Unknown or missing fields fail
closed. The request cannot carry source kind, authority, namespace, issuer,
producer ID, or source-event ID.

## Canonical authorization chain

After the exact operator role gate, trusted broker code fixes:

- source kind: `lineage_contract_frozen`;
- authority kind: `lineage_dispatcher`;
- source namespace: `broker-http:review-lineage-create:v1`;
- issuer: authenticated operator ID.

The semantic dispatcher authority describes the operator's contract-freeze
action; it is never accepted from JSON. The adapter uses the existing Phase 13
carrier authorization, Phase 12 producer-fact admission, and Phase 8 parser.
No second contract, budget, subject, transition, idempotency, or fingerprint
parser is introduced.

## Closed attached-source pairing at Phase 15

At the Phase 15 boundary, only two runtime source tuples were admitted:

| Source kind | Authority | Command | Observation |
| --- | --- | --- | --- |
| `lineage_contract_frozen` | `lineage_dispatcher` | `create_lineage` | `lineage_create` |
| `lineage_cancel_decided` | `operator` | `record_event` | `operator_cancel` |

Cross-kind swaps and the three still-unattached source kinds fail before a
transaction begins. The shared metadata type does not widen coverage beyond
these tuples.

## Atomic admission, replay, and privacy

Schema 13 and `broker_review_lineage_authorized_source_events_v1` are reused
without a schema change. One `BEGIN IMMEDIATE` transaction performs the source
lookup, canonical lineage creation, observation-ledger write, minimized source
write, and commit. Source or ledger failure rolls back every coupled write.

The same authenticated operator, namespace, and immutable dispatch reference
derive the same event identity. The same canonical payload replays after
restart without creating a second lineage. Changed contract, budget, binding,
timestamp, or other evidence under the same reference conflicts. A different
source attempting the same lineage records and replays a subject conflict.

The source-event table stores derived IDs, fixed source/authority classes, a
hash of the dispatch reference, canonical fingerprint, observation time, and
stable outcome. It does not duplicate the raw request, dispatch reference,
contract, operator ID, prompts, credentials, provider output, or production
payload. The canonical lineage table remains the intentional owner of the
frozen contract.

## Rollout and task boundary

`A2A_REVIEW_LINEAGE_MODE=off` returns before request validation, trusted
context construction, or store access. Worker-thread persistence sends one
composite command and returns one ACK; projection refresh happens afterward.

Generic task creation, completion, failure, cancellation, retry, approval, and
finalizer paths remain detached. At the end of Phase 15, `review_report`,
`correction_generation`, and `reviewer_replacement` had no runtime source
owner. Phase 16 later attaches only `review_report`; the other two remain
detached.

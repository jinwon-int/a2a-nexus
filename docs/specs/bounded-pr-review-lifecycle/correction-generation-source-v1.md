# Authenticated correction-generation source v1

Phase 17 attaches the fourth authoritative observation kind:
`correction_generation`. Automatic source coverage becomes exactly `4/5`;
`reviewer_replacement` remains detached.

This is a source implementation and temporary-database test boundary. It does
not enable record mode by default or approve live schema execution, migration,
deployment, restart, canary, provider send, real-lineage collection, ACK or
replay operations, prune, release, or merge.

## Authenticated owner and exact route

The only correction-generation mutation path is:

```text
POST /review-lineages/{lineageId}/correction-generation
```

The route requires an authenticated requester with the exact `operator` role,
even when legacy requester-identity enforcement is relaxed for older routes.
Trusted broker code maps that operator to semantic `correction_controller`
authority. An `operator`, `hub`, reviewer, generic worker, task result, or
request-body claim is not interchangeable with that route decision.

The request body has exactly:

- `generationRef`: immutable reference for the already committed generation;
- `observedAt`: UTC observation time;
- `binding`: exact pre-correction `intentHash`, `headSha`, and `diffHash`;
- `headSha`: next committed head;
- `diffHash`: next canonical diff hash;
- `intentHash`: unchanged frozen intent hash;
- `pathsChanged`: complete changed-path list for scope classification.

Unknown and missing fields fail closed. The request cannot carry source kind,
authority, namespace, issuer, operator identity, producer ID, source-event ID,
patch bytes, fixer output, task state, result prose, or finalizer evidence.

## Trusted authority and canonical parsing

Trusted broker code fixes:

- source kind: `correction_generation_committed`;
- authority kind: `correction_controller`;
- source namespace:
  `broker-http:review-lineage-correction-generation:v1`;
- issuer: authenticated exact-role operator.

Phase 13 authorization derives `producerId` from the trusted authority,
issuer, and namespace. It derives `sourceEventId` from that producer, the fixed
source kind, and immutable generation reference. Neither identity is accepted
from JSON.

The adapter constructs one complete carrier and reuses the Phase 8 parser
through the Phase 13/11 fact chain. That canonical parser validates exact
binding fields, UTC time, SHA/hash syntax, changed-path completeness, unchanged
frozen intent, and a genuinely changed next head/diff. Phase 12 admission then
awaits the existing composite store command. There is no parallel parser or
Map-first mutation.

## Closed attached-source pairing

Exactly four runtime source tuples are admitted:

| Source kind | Authority | Command | Observation |
| --- | --- | --- | --- |
| `lineage_contract_frozen` | `lineage_dispatcher` | `create_lineage` | `lineage_create` |
| `lineage_cancel_decided` | `operator` | `record_event` | `operator_cancel` |
| `review_report_submitted` | `reviewer` | `record_event` | `review_report` |
| `correction_generation_committed` | `correction_controller` | `record_event` | `correction_generation` |

`reviewer_replacement_decided` remains detached. Cross-kind source, authority,
command, or observation substitutions fail before a transaction starts.

## Pending-state, intent, and path boundary

The canonical store accepts the correction command only while the durable
lineage state is `correction_pending`. Any other state records a stable
`transition_rejected` result without changing lineage state, version, counters,
or head. Replay returns that same rejection.

The request binding is a compare-and-set on the complete pre-correction
subject. A stale intent, head, or diff records `subject_conflict` without
mutation. The observation intent must equal the binding intent, and the binding
must equal the canonical frozen intent, so caller-selected intent drift cannot
be admitted.

The existing lifecycle path classifier remains authoritative. A forbidden or
out-of-scope path leaves state at `correction_pending`, preserves the prior head
and diff, does not increment the accepted-generation counter, and stores only
a redacted rejection code in the minimized ledger. An allowed-path event
records the already committed head/diff, increments the bounded generation
counter, and moves to `reviewing_resolution`.

This route does not apply, synthesize, or validate patch bytes. It never invokes
a fixer or auto-pushes output. The original head remains recoverable through the
frozen contract.

## Atomic admission, replay, and rollback

Schema 13 and
`broker_review_lineage_authorized_source_events_v1` are reused without a
migration. One `BEGIN IMMEDIATE` transaction performs:

1. source-event replay or conflict lookup;
2. observation-ledger replay or conflict lookup;
3. exact durable subject and pending-state checks;
4. canonical lifecycle/path transition;
5. canonical lineage and observation-ledger write;
6. minimized source-event write;
7. commit or full rollback.

The same operator, namespace, source kind, and generation reference derive the
same event identity after restart. The same canonical payload replays the
stored outcome. Changed binding, next subject, intent, paths, or timestamp under
that identity conflicts without overwrite. A forced lineage, ledger, or source
failure rolls back every coupled write.

Worker-thread persistence sends one
`applyAuthorizedReviewLineageSource` command and returns one durable ACK. The
broker refreshes its read projection only after that ACK. Queue and database
failures reach the awaited caller.

## Privacy, compatibility, and rollout boundary

The minimized source table stores only derived IDs, fixed source and authority
classes, a hash of the generation reference, canonical payload fingerprint,
observation time, and stable outcome. It stores no raw generation reference,
operator ID, changed path, patch/fixer output, prompt, provider output,
credential, task result, or private source prose. The restricted canonical
lineage remains the intentional owner of validated lifecycle state.

At the broker source boundary, `A2A_REVIEW_LINEAGE_MODE=off` returns before
request parsing, trusted context construction, or store access. The HTTP route
still authenticates the exact operator role and then reports that recording is
disabled. `record` remains the only active mode; `enforce` remains unsupported.

Lineage create, signed review report, and operator cancel retain their existing
owners and routes. Generic task creation, completion, result, evidence,
failure, cancellation, retry, approval, finalizer, and fixer paths remain
detached. The route records already committed generation evidence only.

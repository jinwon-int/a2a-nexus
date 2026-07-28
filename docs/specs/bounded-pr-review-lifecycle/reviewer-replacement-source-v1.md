# Authenticated reviewer-replacement source v1

Phase 18 attaches the fifth and final authoritative observation kind:
`reviewer_replacement`. Authoritative-source attachment coverage is exactly
`5/5`.

This is source implementation and temporary-database test evidence only.
`5/5` describes attachment of the five defined source tuples; it is not
record-mode activation, live schema execution, deployment, independent review,
finalizer closeout, or issue closeout.

## Authenticated owner and exact route

The only reviewer-replacement mutation path is:

```text
POST /review-lineages/{lineageId}/reviewer-replacement
```

The route requires an authenticated requester with the exact `operator` role,
even when legacy requester-identity enforcement is relaxed for older routes.
Trusted broker code maps that authenticated operator issuer to semantic
`reviewer_allocator` authority.

The request body has exactly:

- `decisionRef`: immutable reference for the already classified decision;
- `observedAt`: UTC observation time;
- `binding`: exact current `intentHash`, `headSha`, and `diffHash`.

Unknown and missing fields fail closed. The request cannot carry a reason,
detail, authority, namespace, issuer, operator identity, producer ID,
source-event ID, source kind, reviewer identity, replacement worker, task ID,
or assignment.

## Trusted classification and canonical parsing

Trusted broker code fixes:

- source kind: `reviewer_replacement_decided`;
- authority kind: `reviewer_allocator`;
- source namespace:
  `broker-http:review-lineage-reviewer-replacement:v1`;
- issuer: the authenticated exact-role operator;
- observation kind: `reviewer_replacement`;
- reason: `infrastructure_failure`.

Phase 13 authorization derives `producerId` from the fixed authority, issuer,
and namespace. It derives `sourceEventId` from that producer, the fixed source
kind, and immutable decision reference. Neither identity is accepted from
JSON.

The adapter constructs one complete carrier and reuses the Phase 8 parser
through the Phase 13/11 fact chain. That parser remains the sole authority for
exact binding fields, UTC time, SHA/hash syntax, idempotency key, payload
fingerprint, expected subject, and the existing `reviewer_replacement` engine
command. Phase 12 admission awaits the existing composite store command.

## Closed attached-source set

Exactly five runtime source tuples are admitted:

| Source kind | Authority | Command | Observation |
| --- | --- | --- | --- |
| `lineage_contract_frozen` | `lineage_dispatcher` | `create_lineage` | `lineage_create` |
| `review_report_submitted` | `reviewer` | `record_event` | `review_report` |
| `correction_generation_committed` | `correction_controller` | `record_event` | `correction_generation` |
| `reviewer_replacement_decided` | `reviewer_allocator` | `record_event` | `reviewer_replacement` |
| `lineage_cancel_decided` | `operator` | `record_event` | `operator_cancel` |

Cross-kind source, authority, command, or observation substitutions fail
before a transaction starts. The replacement tuple additionally requires
exact reason `infrastructure_failure` and forbids observation detail.

## State, subject, and shared-budget boundary

The request binding is a compare-and-set on the complete current subject.
Stale intent, head, or diff records `subject_conflict` without canonical
mutation.

A non-terminal admitted replacement increments only the existing
`reviewerReplacements` counter. It does not reset or replace the shared budget,
start time, contract intent, current head, current diff, reviewer-run counter,
correction-generation counter, finding ledger, or other counters. Exceeding
`maxReviewerReplacements` transitions the same lineage to
`blocked_needs_operator`; the existing shared terminal reason remains
`budget_reviewer_runs`, and the exhausted replacement count remains visible in
the operator projection.

Already-terminal lineages record `transition_rejected` instead of persisting an
applied no-op. A terminal lineage cannot be restarted by another replacement
decision.

## Atomic admission, replay, and rollback

Schema 13 and
`broker_review_lineage_authorized_source_events_v1` are reused without a
migration. One `BEGIN IMMEDIATE` transaction performs:

1. source-event replay or conflict lookup;
2. observation-ledger replay or conflict lookup;
3. exact durable subject and terminal-state checks;
4. canonical bounded replacement transition;
5. canonical lineage and observation-ledger write;
6. minimized source-event write;
7. commit or full rollback.

The same operator, namespace, source kind, and decision reference derive the
same event identity after restart. The same canonical payload replays its
stored outcome. A changed timestamp or binding under that identity conflicts
without overwrite. Forced ledger or source failure rolls back the coupled
lineage change.

Worker-thread persistence sends one
`applyAuthorizedReviewLineageSource` command and returns one durable ACK. The
broker refreshes its read projection only after that ACK. Queue and database
failures reach the awaited caller.

## Privacy and non-automation boundary

The minimized source table stores only derived IDs, fixed source and authority
classes, a hash of the decision reference, canonical payload fingerprint,
observation time, and stable outcome. It stores no raw decision reference,
operator ID, reviewer ID, task or assignment data, prompt, log, prose,
provider output, or credential.

This route records an already classified infrastructure-failure decision. It
does not classify generic failures, choose a replacement worker, mutate task
assignment, create or dispatch a task, or start an automatic replacement loop.
Generic task/result/error/log/prose/retry/completion/finalizer state cannot
create this event.

At the broker source boundary, `A2A_REVIEW_LINEAGE_MODE=off` returns before
request parsing, trusted-context construction, or store access. The HTTP route
still authenticates the exact operator role and then reports that recording is
disabled. `record` remains the only active mode; `enforce` remains unsupported.

No live DB/schema execution, activation, deploy, restart, canary, provider
send, Terminal ACK/replay/prune/migration, release/tag, secret/ruleset/history
change, push, merge, or approval weakening is authorized here.

Refs #1518.

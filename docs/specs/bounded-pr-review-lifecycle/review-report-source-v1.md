# Authenticated review-lineage report source v1

Phase 16 attaches the third authoritative observation kind:
`review_report`. Automatic source coverage becomes exactly `3/5`.

This is a source implementation and temporary-database test boundary. It does
not enable record mode by default or approve live schema execution, migration,
deployment, restart, canary, provider send, real-lineage collection, ACK or
replay operations, prune, release, or merge.

## Authenticated owner and route

The only review-report mutation path is:

```text
POST /review-lineages/{lineageId}/review-report
```

The route always requires the existing Ed25519 worker HTTP-signature registry.
The verified signing-key owner is the reviewer issuer. A requester header or
request-body field cannot independently select that issuer. A scoped key must
carry the dedicated `review-lineage.report` grant; a valid signature
without that route scope fails closed.

The request body has exactly:

- `reportRef`: immutable review-submission reference;
- `observedAt`: UTC observation time;
- `binding`: exact `intentHash`, `headSha`, and `diffHash`;
- `receipt`: complete `ReviewReceiptV1`;
- `resolvedFindingIds`;
- `reopenedFindingIds`;
- `newFindings`.

Unknown and missing fields fail closed. The request cannot carry an issuer,
authority, namespace, source kind, producer ID, or source-event ID.

## Canonical issuer and receipt proof

The adapter passes the verified signing-key owner to the canonical Phase 8
`ReviewReceiptV1` parser. That parser validates the complete receipt and proves
that the trusted issuer equals `receipt.reviewerNodeId`. A mismatch fails before
the source carrier or transaction can be admitted.

Trusted broker code then fixes:

- source kind: `review_report_submitted`;
- authority kind: `reviewer`;
- source namespace: `broker-http:review-lineage-review-report:v1`;
- issuer: verified signing-key owner.

The adapter reuses Phase 13 carrier authorization, Phase 12 awaited
producer-fact admission, and the Phase 8 observation parser. The receipt's
intent, head, diff, ledger reference, author independence, finding transitions,
and complete event fingerprint therefore remain canonical. No task completion,
result, validation summary, log, provider output, or prose is converted into a
report.

## Closed attached-source pairing

Only three runtime source tuples are admitted:

| Source kind | Authority | Command | Observation |
| --- | --- | --- | --- |
| `lineage_contract_frozen` | `lineage_dispatcher` | `create_lineage` | `lineage_create` |
| `lineage_cancel_decided` | `operator` | `record_event` | `operator_cancel` |
| `review_report_submitted` | `reviewer` | `record_event` | `review_report` |

`correction_generation_committed` and `reviewer_replacement_decided` remain
detached. Cross-kind source, authority, command, or observation substitutions
fail before a transaction starts.

## Atomic admission, replay, and rollback

Schema 13 and `broker_review_lineage_authorized_source_events_v1` are reused
without a migration. One `BEGIN IMMEDIATE` transaction performs:

1. source-event replay or conflict lookup;
2. observation-ledger replay or conflict lookup;
3. exact durable subject comparison and lifecycle transition;
4. canonical lineage and observation-ledger write;
5. minimized source-event write;
6. commit or full rollback.

The same verified reviewer, namespace, source kind, and report reference derive
the same event identity after restart. The same canonical payload replays the
stored outcome. Changed receipt, findings, binding, or timestamp under that
identity conflicts without overwrite. A forced lineage, ledger, or source
failure rolls back every coupled write.

Worker-thread persistence sends one `applyAuthorizedReviewLineageSource`
command and returns one durable ACK. The broker refreshes its read projection
only after that ACK. Record-mode admission is awaited; queue and database
failures reach the caller.

## Privacy and rollout boundary

The minimized source table stores only derived IDs, fixed source and authority
classes, a hash of the report reference, the canonical payload fingerprint,
observation time, and stable outcome. It stores no raw report reference,
reviewer ID, receipt note, finding prose, prompt, provider output, credential,
or private source prose. The restricted canonical lineage remains the
intentional owner of the validated receipt and finding state.

At the broker source boundary, `A2A_REVIEW_LINEAGE_MODE=off` returns before
request/receipt parsing, trusted context construction, or store access. The
HTTP route still authenticates the caller and then reports that recording is
disabled. `record` remains the only active mode; `enforce` remains unsupported.

Generic task creation, completion, result, evidence, failure, cancellation,
retry, approval, finalizer, and fixer paths remain detached. Current automatic
coverage is exactly `3/5`; correction generation and reviewer replacement have
no runtime source owner.

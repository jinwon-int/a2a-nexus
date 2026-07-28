# Authenticated review-lineage report source v1

Phase 16 attaches the third authoritative observation kind:
`review_report`. Automatic source coverage becomes exactly `3/5`.

This is a production-source and temporary-database test boundary. It does not
enable record mode by default or approve live schema execution, migration,
deployment, restart, canary, or real-lineage collection.

## Authenticated owner and exact request

The mutation path is:

```text
POST /review-lineages/{lineageId}/review-report
```

This route requires a valid A2A Ed25519 worker signature even when the broader
worker-signature rollout mode would otherwise allow unsigned compatibility
traffic. The verified signing-key owner is the reviewer issuer. A declared
scoped key needs `review-lineage.report`; invalid, revoked, expired,
out-of-scope, unsigned, or replayed signatures fail closed through the existing
broker signature boundary.

The request body has exactly:

- `reportRef`: immutable review-submission reference;
- `observedAt`: UTC observation time;
- `binding`: exact `intentHash`, `headSha`, and `diffHash`;
- `receipt`: complete `ReviewReceiptV1`;
- `resolvedFindingIds`;
- `reopenedFindingIds`;
- `newFindings`.

All seven fields are required. Unknown fields fail closed. The request cannot
carry source kind, authority, namespace, issuer, producer ID, or source-event
ID. It also cannot substitute a task, result, log, prompt, provider payload,
credential, or prose summary for the complete review observation.

## Canonical authentication and validation chain

After signature verification, trusted broker code fixes:

- source kind: `review_report_submitted`;
- authority kind: `reviewer`;
- source namespace: `broker-http:review-lineage-review-report:v1`;
- issuer: verified signing-key owner.

Phase 13 authorization requires that issuer to equal
`ReviewReceiptV1.reviewerNodeId`. The existing Phase 8 parser remains the sole
complete validator for receipt fields, author/reviewer independence when the
trusted author is present, exact subject and ledger binding, finding
transitions, resolution-review eligibility, idempotency, and fingerprinting.
Phase 12 admission remains the awaited command boundary. No task-completion or
review-validation prose is converted into a report.

## Closed attached-source pairing

Only three runtime source tuples are admitted:

| Source kind | Authority | Command | Observation |
| --- | --- | --- | --- |
| `lineage_contract_frozen` | `lineage_dispatcher` | `create_lineage` | `lineage_create` |
| `review_report_submitted` | `reviewer` | `record_event` | `review_report` |
| `lineage_cancel_decided` | `operator` | `record_event` | `operator_cancel` |

Cross-kind swaps and the two still-unattached source kinds,
`correction_generation_committed` and `reviewer_replacement_decided`, fail
before a transaction begins. Generic task creation, completion, failure,
cancellation, retry, result validation, approval, and finalizer output remain
detached.

## Atomic admission, replay, and privacy

Schema 13 and
`broker_review_lineage_authorized_source_events_v1` are reused without a schema
change. One SQLite `BEGIN IMMEDIATE` performs source-event lookup, exact-subject
lineage transition, observation-ledger write, minimized source-event write, and
commit. The worker-thread path sends that admission as one queue command and
returns one ACK. The broker refreshes its projection only after the durable ACK.
Source or ledger failure rolls back the lineage, ledger, and source writes.

The same authenticated reviewer, namespace, and immutable report reference
derive the same event identity. An identical payload replays after restart.
Changed receipt, findings, binding, timestamp, or other payload under the same
reference conflicts without overwriting the original outcome.

The minimized source-event row stores only derived IDs, fixed source/authority
classes, a hash of the report reference, canonical payload fingerprint,
observation time, and stable outcome. It does not store the raw report
reference, reviewer or author ID, `ReviewReceiptV1`, review note/private prose,
findings, prompts, provider payloads, credentials, logs, or generic task/result
data. The canonical lineage remains the intentional owner of the validated
receipt and finding ledger.

## Rollout boundary

`A2A_REVIEW_LINEAGE_MODE=off` returns before request validation, trusted-context
construction, or store access. `record` mode awaits the atomic ACK. `enforce`
remains unsupported.

`correction_generation` and `reviewer_replacement` remain detached. Current
automatic authoritative-source coverage is exactly `3/5`.

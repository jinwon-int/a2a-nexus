# Review-lineage observation v1

`ReviewLineageObservationEnvelopeV1` is the lossless source contract between a
future record-mode producer and the existing bounded review-lineage engine. It
does not attach a producer to task completion and does not authorize a broker
mutation.

The machine-readable schema is
[`schemas/review-lineage-observation-v1.json`](schemas/review-lineage-observation-v1.json).
The strict parser and pure projector are in
`packages/broker/src/review-lifecycle/observation.ts`.

## Required source evidence

Every envelope supplies all of the following without inference:

- a producer-stable `sourceEventId`;
- the exact lineage id and UTC observation time;
- the frozen `intentHash`;
- the exact current 40-character `headSha`;
- the canonical patch `diffHash`;
- one complete existing engine input: lineage creation, review report,
  correction generation, reviewer replacement, or operator cancellation.

Free text, GitHub state, task status, result prose, provider output, prompts, or
the parser's wall clock are not evidence for a missing field. Unknown fields,
unknown versions, malformed hashes, and incomplete event transitions fail
closed.

## Compare-and-set subject

`binding` is the expected durable subject before the projected command is
applied.

- `lineage_create`: it matches the frozen contract head and intent. Its
  `diffHash` is the original canonical diff.
- `review_report`: it exactly matches the review receipt subject.
- `correction_generation`: it identifies the current pre-correction subject.
  The observation separately carries the proposed next head and diff.
- `reviewer_replacement` and `operator_cancel`: it identifies the current
  subject when the control event was observed.

The pure projector preserves this value as `expectedSubject`. A future runtime
adapter must compare it with the durable record before calling the store. This
phase intentionally adds no such adapter.

## Replay and conflicts

The parser derives:

```text
idempotencyKey =
  sha256("review-lineage-observation/v1\0" + producerId + "\0" + sourceEventId)

payloadFingerprint =
  sha256(canonical JSON of the normalized complete envelope)
```

The batch parser treats the same key and fingerprint as one command. The same
key with a different fingerprint is `idempotency_conflict`. A future durable
adapter must persist this pair before applying a command; this source-only
phase proves deterministic replay but does not claim process-restart
exactly-once effects.

## Privacy and error surface

All objects use allowlisted fields and bounded strings/arrays. Validation errors
return only a stable error code and JSON path. They never copy the rejected
value or the original envelope into the error.

The frozen `IntentContractV1` and finding evidence can still be sensitive even
when structurally valid. A live producer therefore needs a separately reviewed
retention/redaction policy before this envelope can be persisted or exported.

## Explicit non-goals

This contract does not:

- subscribe to task completion, retries, GitHub, providers, or finalizer output;
- add a broker/store/HTTP mutation call site;
- enable runtime `enforce` or change `DEFAULT_LINEAGE_BUDGET`;
- apply fixer output, push, merge, deploy, restart, send, ACK, replay, or mutate
  DB/outbox state;
- replace signed finalizer verification or reviewer-independence gates.

The next gate is a separately reviewed durable adapter with persistent
idempotency conflict detection, exact-subject comparison, producer completeness
proof, and an approved privacy/retention boundary.

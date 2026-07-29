# Task Attempt Failure Sharing V1

Status: source-only P2-B contract slice. Refs #1635.

This package defines a public-safe record contract, two read-only advisory
views, synthetic fixtures, and deterministic conformance only. It does not add
a runtime producer, consumer, route, store, schema, migration, exchange write,
dispatcher enforcement, automatic retry, or issue completion.

## 1. Problem and evidence boundary

Current broker data does not reliably encode semantic hypothesis identity or
experiment disposition. A task message, execution failure detail, retry state,
or broker-local attempt identifier cannot honestly establish that two attempts
tested the same hypothesis. Those values also may contain private content.

V1 therefore accepts a record only from one of two explicit producer domains:

- `producerKind=broker_execution` reports only broker execution outcomes that
  the broker execution producer can structure.
- `producerKind=bounded_experiment` reports experiment dispositions only when
  an explicit bounded-experiment producer assigned the experiment and
  hypothesis identities before emitting the record.

The two domains have different field names and closed vocabularies. There is no
common `status` field and no translation from one vocabulary to the other.

| Producer kind | Result field | Closed V1 vocabulary |
| --- | --- | --- |
| `broker_execution` | `brokerOutcome` | `succeeded`, `failed`, `canceled`, `superseded` |
| `bounded_experiment` | `experimentDisposition` | `keep`, `discard`, `crash` |

In particular, V1 never derives `keep`, `discard`, or `crash` from a task
message, execution failure detail, retry state, or broker attempt identifier.

## 2. Public-safe input rule

Every accepted value is an allowlisted contract field. A V1 record has no
caller extension point.

The record and both views MUST NOT contain or reflect:

- free-form failure detail, reason text, messages, prompts, payloads, or claim
  text;
- a digest, encoding, excerpt, or tokenization of any private or free-form
  text;
- credentials, filesystem paths, URLs, or precise timestamps;
- requester, provider, worker, or person identity;
- arbitrary labels, metadata maps, caller-defined fields, or extensions.

A digest of private text is still private correlation material and is
forbidden. The only digests in V1 are computed from the closed, public-safe
fields specified here.

Public identifiers use opaque, non-time-derived tokens:

| Field | Required form | Meaning |
| --- | --- | --- |
| `brokerOfRecord` | `brk_` plus 16 lowercase hexadecimal characters | registered public-safe broker alias |
| `taskId` | `tsk_` plus 32 lowercase hexadecimal characters | producer-issued public task alias |
| `retryRootTaskId` | same as `taskId` | first task alias in one retry sequence |
| `experimentId` | `exp_` plus 32 lowercase hexadecimal characters | explicit bounded experiment |
| `hypothesisId` | `hyp_` plus 32 lowercase hexadecimal characters | explicit hypothesis inside that experiment |

These identifiers MUST be randomly assigned or drawn from a reviewed
public-safe registry. They MUST NOT encode a timestamp, path, URL, identity,
free-form text, or a digest of such material. Syntax validation alone cannot
prove provenance; a future producer admission review must prove the assignment
rule before runtime use.

## 3. `TaskAttemptRecordV1`

All objects are closed. `version` is the integer `1`. All strings are ASCII
and are bounded by their enum or identifier grammar. `attemptOrdinal` is an
integer from 1 through 1024.

### 3.1 Common fields

| Field | Rule |
| --- | --- |
| `kind` | exactly `TaskAttemptRecordV1` |
| `version` | exactly `1` |
| `producerKind` | one of the two producer discriminants |
| `producerContract` | exact constant selected by `producerKind` |
| `brokerOfRecord` | public-safe broker alias |
| `taskId` | public-safe task alias for this attempt |
| `retryRootTaskId` | public-safe task alias for ordinal 1 |
| `attemptOrdinal` | 1-based ordinal within the retry root |
| `identityDigestDomain` | exact domain selected by `producerKind` |
| `fingerprintDigestDomain` | exact domain selected by `producerKind` |
| `recordKey` | deterministic identity digest |
| `fingerprint` | deterministic full-record fingerprint |

The producer constants and digest domains are:

| `producerKind` | `producerContract` | `identityDigestDomain` | `fingerprintDigestDomain` |
| --- | --- | --- | --- |
| `broker_execution` | `a2a.broker-execution.v1` | `a2a.task-attempt-record.v1.identity.broker-execution` | `a2a.task-attempt-record.v1.fingerprint.broker-execution` |
| `bounded_experiment` | `a2a.bounded-experiment.v1` | `a2a.task-attempt-record.v1.identity.bounded-experiment` | `a2a.task-attempt-record.v1.fingerprint.bounded-experiment` |

Changing the producer or broker of record changes the canonical identity and
therefore changes `recordKey`. Once a key is accepted, its producer binding
and broker-of-record binding are immutable.

### 3.2 Broker execution variant

A broker execution record has `brokerOutcome` and never has
`experimentDisposition`, `experimentId`, or `hypothesisId`.

```json
{
  "kind": "TaskAttemptRecordV1",
  "version": 1,
  "producerKind": "broker_execution",
  "producerContract": "a2a.broker-execution.v1",
  "brokerOfRecord": "brk_1111111111111111",
  "taskId": "tsk_11111111111111111111111111111111",
  "retryRootTaskId": "tsk_11111111111111111111111111111111",
  "attemptOrdinal": 1,
  "brokerOutcome": "failed",
  "reasonClass": "dependency_failure",
  "reasonCode": "dependency_unavailable",
  "identityDigestDomain": "a2a.task-attempt-record.v1.identity.broker-execution",
  "fingerprintDigestDomain": "a2a.task-attempt-record.v1.fingerprint.broker-execution",
  "recordKey": "sha256:<64 lowercase hexadecimal characters>",
  "fingerprint": "sha256:<64 lowercase hexadecimal characters>"
}
```

The reason vocabulary is closed and outcome-specific:

| Outcome | Allowed structured reason |
| --- | --- |
| `succeeded` | `reasonClass` and `reasonCode` absent |
| `failed` | class/code pair from: `execution_failure/producer_reported_failure`, `dependency_failure/dependency_unavailable`, `resource_exhaustion/limit_exceeded`, `contract_rejection/invalid_request` |
| `canceled` | `cancellation/before_start` or `cancellation/during_execution` |
| `superseded` | `supersession/newer_attempt` |

A producer that cannot select one of these values cannot emit a V1 record. It
must not substitute free-form detail.

### 3.3 Bounded experiment variant

A bounded experiment record has `experimentId`, `hypothesisId`, and
`experimentDisposition`. It never has `brokerOutcome`.

```json
{
  "kind": "TaskAttemptRecordV1",
  "version": 1,
  "producerKind": "bounded_experiment",
  "producerContract": "a2a.bounded-experiment.v1",
  "brokerOfRecord": "brk_1111111111111111",
  "taskId": "tsk_22222222222222222222222222222222",
  "retryRootTaskId": "tsk_22222222222222222222222222222222",
  "attemptOrdinal": 1,
  "experimentId": "exp_11111111111111111111111111111111",
  "hypothesisId": "hyp_11111111111111111111111111111111",
  "experimentDisposition": "discard",
  "reasonClass": "measurement_result",
  "reasonCode": "no_improvement",
  "identityDigestDomain": "a2a.task-attempt-record.v1.identity.bounded-experiment",
  "fingerprintDigestDomain": "a2a.task-attempt-record.v1.fingerprint.bounded-experiment",
  "recordKey": "sha256:<64 lowercase hexadecimal characters>",
  "fingerprint": "sha256:<64 lowercase hexadecimal characters>"
}
```

The disposition-specific reason vocabulary is:

| Disposition | Allowed structured reason |
| --- | --- |
| `keep` | `reasonClass` and `reasonCode` absent |
| `discard` | `measurement_result/no_improvement`, `measurement_result/regression`, or `measurement_validity/invalid_measurement` |
| `crash` | required class `execution_crash`, `resource_exhaustion`, or `dependency_failure`; optional matching code `process_exit`, `limit_exceeded`, or `dependency_unavailable` |

The optional crash code permits an honest producer to report only a stable
class. It does not permit free-form detail.

## 4. Identity and retry semantics

The canonical identity payload is a closed object.

For `broker_execution`, it contains exactly:

`kind`, `version`, `producerKind`, `producerContract`, `brokerOfRecord`,
`taskId`, `retryRootTaskId`, and `attemptOrdinal`.

For `bounded_experiment`, it contains those fields plus `experimentId` and
`hypothesisId`.

Within one retry sequence:

1. ordinal 1 MUST have `taskId == retryRootTaskId`;
2. later ordinals MUST be unique and contiguous when a complete sequence is
   presented;
3. producer kind, producer contract, and broker of record MUST remain equal;
4. a bounded experiment sequence additionally keeps `experimentId` and
   `hypothesisId` equal;
5. a broker retry root says only that the records belong to one explicit
   broker retry sequence. It does not claim semantic hypothesis equality.

`attemptOrdinal` is producer-emitted contract data. It is never inferred from
retry counters, ordering timestamps, or a broker-local `attemptId`.

## 5. Canonical encoding and digests

Canonical JSON is recursively encoded as follows:

- object keys are sorted by ascending ASCII byte value;
- arrays retain their specified order;
- strings use JSON escaping and UTF-8;
- integers use their minimal base-10 JSON form;
- there is no insignificant whitespace;
- `null`, floating-point numbers, and non-ASCII strings are not valid record
  values.

V1 digest framing is the byte concatenation:

1. ASCII `A2A-TAFS-FRAME-V1` followed by one zero byte;
2. a 4-byte unsigned big-endian domain byte length;
3. the UTF-8 domain bytes;
4. a 4-byte unsigned big-endian canonical-payload byte length;
5. the canonical JSON payload bytes.

The result is lowercase SHA-256 with the `sha256:` prefix.

`recordKey` is the framed digest of the canonical identity payload under the
record's exact identity domain.

`fingerprint` is the framed digest of the complete closed record excluding
only `fingerprint`, under the record's exact fingerprint domain. It therefore
includes `recordKey`, both domain fields, the immutable producer/broker
binding, the outcome or disposition, and the structured reason fields.

The domain strings are part of the contract, not caller input. A domain that
does not match `producerKind`, or a result field/vocabulary from the other
producer domain, is malformed.

## 6. Replay and conflict behavior

Validation occurs before any replay decision:

- missing, malformed, extra-field, unknown-version, vocabulary-mismatched, or
  digest-invalid input is rejected as `contract_rejected`;
- an absent `recordKey` is accepted once as `accepted`;
- the same key with byte-equivalent canonical payload and the same fingerprint
  is `idempotent_replay` and has no additional effect;
- the same key with a different validated payload or fingerprint is
  `same_key_payload_conflict` and fails closed;
- even if two payloads present the same fingerprint, non-equivalent canonical
  payloads conflict.

Contract rejection and conflict are boundary results only. They MUST NOT
cancel a task, deny a claim, authorize retry, finalize an attempt, mark
success, or otherwise change task execution.

## 7. Exchange failure-channel projection

`TaskAttemptFailureChannelProjectionV1` is a closed, read-only advisory view.
This slice defines its deterministic shape but performs no exchange write.

Eligible source results retain their producer vocabulary:

- broker: `failed`, `canceled`, and `superseded`;
- bounded experiment: `discard` and `crash`.

`succeeded` and `keep` are not failure-channel entries. No eligible value is
translated into the other producer's vocabulary.

The projection has exactly:

- `kind=TaskAttemptFailureChannelProjectionV1`;
- `version=1`;
- `viewMode=read_only_advisory`;
- `entries`, an array of 0 through 64 closed
  `TaskAttemptFailureProjectionEntryV1` values.

An entry contains the source `recordKey`, `fingerprint`, producer/broker
binding, task/retry identity, ordinal, the source result field, and structured
reason fields. Experiment entries also contain `experimentId` and
`hypothesisId`. It contains no other field.

Entries are canonically ordered by the ASCII tuple:

`producerKind`, `brokerOfRecord`, `retryRootTaskId`, `experimentId-or-empty`,
`hypothesisId-or-empty`, `attemptOrdinal`, `recordKey`.

The projection is not a claim decision, retry authority, finalizer verdict,
success evidence, or automatic dispatch policy.

## 8. Dispatcher same-attempt-history preflight

`TaskAttemptHistoryPreflightResponseV1` is another closed, read-only advisory
view. It returns prior eligible failure entries for a future ordinal in the
same explicit retry identity.

Its closed fields are:

- `kind=TaskAttemptHistoryPreflightResponseV1`;
- `version=1`;
- `viewMode=read_only_advisory`;
- `query`, a closed producer-specific identity with
  `candidateAttemptOrdinal`;
- `priorFailures`, canonically ordered and limited to 32 entries;
- `automaticDeny=false`;
- `retryAuthority=not_provided`;
- `finalizerVerdict=not_provided`;
- `successEvidence=false`;
- `automaticDispatchPolicy=none`.

The query selects records with the same producer/broker/retry-root binding and
an ordinal lower than `candidateAttemptOrdinal`. An experiment query also
requires the same explicit experiment and hypothesis identifiers. A broker
query does not infer a hypothesis.

Consumers may show this view to a dispatcher or operator. They MUST NOT turn
presence, absence, count, class, or code into automatic denial, retry,
finalization, success, or dispatch behavior.

## 9. Fail-closed compatibility

Missing data, malformed data, unknown versions, unknown producer kinds,
unknown fields, unknown enum values, incorrect cross-field combinations, and
invalid digests fail closed at this contract boundary. They are treated as no
usable TaskAttemptRecordV1 data.

Failing closed here leaves existing task execution unchanged. In particular,
absence or rejection of sharing data cannot deny a claim, cancel or retry an
attempt, alter finalization, or supply evidence of success.

## 10. Conformance and scope

The public synthetic golden fixture is
`fixtures/contract/task-attempt-failure-sharing.json`. The deterministic
checker is `test/conformance/check-task-attempt-failure-sharing.mjs` and is
registered in the existing `npm run test:conformance` runner.

The fixture pins:

- broker failure followed by retry success;
- explicit experiment discard followed by keep;
- explicit experiment crash with only a stable class;
- exact replay and same-key/different-payload conflict;
- malformed identity, domain/vocabulary mismatch, and closed-field rejection;
- canonical key/fingerprint vectors;
- failure-channel projection and an advisory preflight that returns a prior
  failure without automatic denial.

The checker uses only Node.js built-ins and local files. It performs no network
access.

This P2-B slice does not complete #1635 and makes no runtime behavior claim.

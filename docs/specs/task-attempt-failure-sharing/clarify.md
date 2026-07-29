# Clarifications: Task Attempt Failure Sharing V1

Refs #1635.

## Q1. Can existing broker attempts be backfilled as experiments?

No. Current messages, failure details, retry state, and broker-local attempt
identifiers do not reliably establish semantic hypothesis identity or
experiment disposition. V1 experiment records require an explicit
bounded-experiment producer and preassigned public-safe `experimentId` and
`hypothesisId`.

## Q2. Is a broker `failed` outcome equivalent to experiment `crash`?

No. The domains deliberately have different result fields and vocabularies.
There is no normative mapping between `failed` and `crash`, or between
`succeeded` and `keep`.

## Q3. May a producer hash private detail into a reason code or identifier?

No. Hashing, encoding, excerpting, or tokenizing private or free-form text
does not make it public-safe. Identifiers are random or registry-assigned
opaque aliases. Reasons come only from closed class/code enums.

## Q4. Why bind both producer and broker of record?

They answer different questions. `producerKind` and `producerContract`
identify the semantics the emitter is allowed to assert. `brokerOfRecord`
identifies the public-safe broker authority under which the attempt sequence
is recorded. Both are part of the identity digest and cannot be changed for
an accepted key.

## Q5. What does retry-root equality prove?

For broker execution it proves only membership in one explicitly emitted
retry sequence. It does not prove the same semantic hypothesis. For bounded
experiments, sameness additionally requires the explicit experiment and
hypothesis identifiers.

## Q6. Why can `crash` omit `reasonCode`?

An explicit experiment producer may reliably know a stable crash class while
lacking a safe stable code. Rejecting such a record would encourage free-form
detail or false precision. The class remains required and closed.

## Q7. Do replay conflicts affect a live task?

No. Contract rejection and same-key/different-payload conflict are
ingress-boundary outcomes. V1 defines no runtime consumer and gives them no
claim, retry, cancellation, finalization, success, or dispatch authority.

## Q8. Is the exchange projection an exchange event?

No. It is a deterministic read-only view definition. This slice adds no
exchange write, route, consumer, persistence, or schema.

## Q9. May dispatcher preflight automatically avoid an attempt?

No. The response fixes every authority field to a non-authoritative value.
Prior failures are advisory context only. A later policy proposal requires a
separate contract, implementation, review, and approval.

## Q10. What happens for missing or future-version records?

They fail at the V1 boundary and cannot enter advisory views. Task execution
continues under its existing contracts.

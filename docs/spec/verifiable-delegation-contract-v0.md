# Verifiable Delegation Contract v0 (#1304 M6)

Status: **v0 draft, repository-internal.** This document extracts the
delegation-contract protocol that the a2a-nexus broker enforces in production
into a contract-form specification: what a task MUST declare before dispatch,
what a failure MUST read back, and what independent verification a completion
MUST carry. The broker is the reference implementation; the machine-readable
conformance blocks below are compared against the broker source by
`scripts/check-spec-broker-conformance.mjs` on every CI run, so this document
cannot silently drift from the implementation.

Words MUST/SHOULD/MAY follow RFC 2119. External publication (package, spec
site, standards proposal) is out of scope for v0 — see the appendix.

## 1. Task Contract (Definition of Ready)

A delegated change task MUST declare, in its payload, everything needed to
judge the work before any worker claims it:

- `acceptance` — how the result is judged (the reference implementation
  accepts a structured acceptance object; a malformed one is a readiness
  failure, not a runtime surprise).
- `declaredScope.paths` — a non-empty list of non-empty path strings the
  change is allowed to touch. Scope creep becomes detectable instead of
  anecdotal.
- `evidenceGate` — a non-empty string naming the evidence the completion MUST
  attach (e.g. a red→green requirement).

The gate applies to change-producing tasks: intents `propose_patch` /
`apply_local_change`, payload modes `github-propose-patch` / `propose-patch` /
`patch`, or an explicit `patchIntent: true`. Read-only tasks MAY omit the
contract fields.

Enforcement runs in one of two modes — `warn` (report, do not block; the
default) and `enforce` (reject with error code `spec_underspecified` at
create time). A deployment SHOULD run `warn` first and flip to `enforce` only
after observing its own dispatch traffic. The reference judgment for a
missing contract is the broker's create-path readiness evaluation.

```json conformance
{
  "conformanceKey": "task-contract",
  "requiredFields": ["acceptance", "declaredScope", "evidenceGate"],
  "gatedIntents": ["propose_patch", "apply_local_change"],
  "gatedModes": ["github-propose-patch", "propose-patch", "patch"],
  "modes": ["warn", "enforce"],
  "defaultMode": "warn",
  "errorCode": "spec_underspecified",
  "source": "packages/broker/src/task-readiness.ts"
}
```

## 2. Failure Readback

A failed delegation MUST read back enough to classify the failure without
access to the worker host, and no more:

- `error.details.stage` MUST be one of the closed stage enum below — the
  phase axis finalizers classify on.
- `error.details.excerpt` MUST be bounded (at most the line/char caps below)
  and MUST pass the broker's redaction path before storage: secrets, tokens,
  contact handles, and private host paths never reach repo-visible readback.
- Raw logs and prompts MUST NOT be stored in readback fields.

```json conformance
{
  "conformanceKey": "failure-readback",
  "stages": ["dispatch", "projection", "handler", "acceptance", "verification"],
  "excerptMaxLines": 20,
  "excerptMaxChars": 4000,
  "source": "packages/broker/src/core/task-error-details.ts"
}
```

## 3. Independent Verification

A completion that claims verification MUST carry it as structured
`result.validations[]` entries, and the verification MUST be independent:

- Each validation entry declares a `kind` from the closed kind enum and a
  `verdict` from the closed verdict enum below, plus the validator's node id
  and a non-empty note.
- When a task requires review (`payload.review.required`), the completion
  MUST include a `review`-kind validation whose reviewer is NOT the
  author/claiming worker — self-certification is rejected with error code
  `review_not_independent`. This is the mechanical form of judge≠producer
  independence; the signed finalizer verdict track
  (`contracts/a2a/finalizer-verdict.md`) is its portable extension.

```json conformance
{
  "conformanceKey": "independent-verification",
  "validationKinds": ["backfill", "paper", "replay", "review", "smoke"],
  "verdicts": ["pass", "fail", "warn"],
  "independenceErrorCode": "review_not_independent",
  "sources": ["packages/broker/src/core/types.ts", "packages/broker/src/worker-review.ts"]
}
```

## 4. Versioning and Compatibility

- The spec version is this document's `v0`. Breaking contract changes MUST
  bump the version and keep the previous document in place.
- The reference implementation evolves behind **dated cutoffs** rather than
  flag days: records created before a cutoff keep legacy semantics, records
  after it get the strict semantics (the `LEGACY_SINGLETON` acceptance cutoff
  below is the live example of the pattern, #1252). A conforming
  implementation SHOULD adopt the same pattern: additive first, dated cutoff
  second, removal only after the window closes.
- Unknown payload fields MUST be preserved (the broker's schemas are
  passthrough for forward compatibility); unknown values in the closed enums
  above MUST be rejected.

```json conformance
{
  "conformanceKey": "versioning",
  "legacySingletonAcceptanceCutoffIso": "2026-07-04T02:30:00.000Z",
  "source": "packages/broker/src/worker-acceptance.ts"
}
```

## Appendix A — conformance block contract

Each fenced block above is JSON with a `conformanceKey` and a `source` (or
`sources`) citing the broker file(s) the values are extracted from. The CI
checker fails when: a registered key is missing from the spec, the spec
carries an unknown key, a cited source file does not exist, or any value
diverges from what it extracts out of the broker source. Editing either side
requires editing both — that is the point.

## Appendix B — external publication prep (decisions only, no execution)

Deliberately unexecuted in v0; every item below is operator-gated:

1. **Packaging**: whether the offline verifiers
   (`verify-analysis-report.mjs`, `verify-finalizer-verdict.mjs`,
   `check-attestation-bundle.mjs`) ship together with this contract as one
   consumer package, and under what name.
2. **License** for the spec text vs the reference implementation.
3. **Publication venue**: npm package, spec site, or standards-body
   submission — each is a separate approval with its own redaction review.
4. **Naming**: the public name for the contract (this document deliberately
   avoids coining one before M1/M3-style field evidence accumulates under it).

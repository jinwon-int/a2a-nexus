# Contract: Finalizer Verdict v1

Status: v1. Umbrella: referee track #1354. Builds on G2 result provenance
(#1356/#1380). Composes G1 policy engine (#1355) and the verifiable report
(#1378/#1381). Shares the offline JCS+JWS primitives in
`scripts/lib/a2a-offline-verify.mjs`.

A **finalizer verdict** is a signed, subject-bound GO/NO-GO attestation produced
by an independent finalizer. It makes the finalizer role **portable and
capture-resistant**: a party who does not trust your broker can still verify
"an independent finalizer rendered GO on this exact artifact." That is what a
broker-as-finalizer can never provide — the broker certifies its own rounds and
its verdict is unverifiable to outsiders.

## 1. Separation of judgment and enforcement

The design mirrors provenance exactly (validity ≠ quality):

- **The finalizer judges quality** — independent, evidence-based, fallible. It
  signs a verdict.
- **The gate enforces validity** — mechanical, fail-closed. It checks that a
  *valid* verdict exists; it never re-runs the judgment.

Neither collapses into the other. The gate gives the independent verdict teeth;
the independence gives the gate's decision legitimacy.

## 2. Two invariants

1. **Independence (judge ≠ player)** — the `finalizerKeyId` MUST NOT be a key
   that produced the subject. Self-certification is rejected. Finalizer keys and
   worker keys live in disjoint role registries (V-c); the gate additionally
   checks the producing worker key ids as belt-and-suspenders. (Mechanical form
   of the K3 finalizer-purity principle.)
2. **Validity ≠ quality** — a verdict proves "an independent finalizer rendered
   GO on this exact artifact with this evidence," never "the artifact is
   correct." A conforming verdict MUST carry an `assurance` block declaring it
   does not prove `analytical-correctness`, and the verifier refuses a verdict
   that omits it.

## 3. Verdict shape

```jsonc
{
  "schemaVersion": "a2a.finalizer.verdict.v1",
  "canonicalization": "rfc8785-jcs-v1",
  "subject": { "kind": "pr", "prHeadSha": "…" },   // pr | task-result | round; resultHash / roundId for the others
  "decision": "go",                                 // go | no-go
  "evidenceRefs": [ { "kind": "red-green|conformance|suite", "ref": "…" } ],
  "assurance": {
    "proves": ["independent-review-occurred", "verdict-integrity", "subject-binding"],
    "doesNotProve": ["analytical-correctness"],
    "disclaimer": "Attests an independent GO on this exact artifact; does not certify correctness."
  },
  "finalizerKeyId": "…",
  "producedAt": "ISO-8601",
  "sig": { "protected": "…", "signature": "…" }      // JWS over JCS(verdict sans sig)
}
```

The signature covers `JCS(verdict sans sig)`, so `subject`, `decision`,
`finalizerKeyId`, and `producedAt` are all tamper-bound. Because `subject`
carries the exact `prHeadSha` (or `resultHash`), a verdict cannot be transplanted
to a different artifact or replayed against a moved head.

## 4. Verification vs enforcement

**Verifier** (`scripts/verify-finalizer-verdict.mjs`, offline, broker-independent)
— checks verdict INTEGRITY: shape, the assurance invariant, and the signature
against the named finalizer key (fail-closed on unknown key). Optionally checks
subject binding when the expected subject is supplied. It does not decide
enforcement.

**Gate** (`scripts/check-finalizer-verdict.mjs`, warn→enforce) — for a PR,
requires fail-closed:
1. verifier integrity passes with the finalizer key resolved in the **registered
   finalizer keyring**,
2. `subject` bound to this exact PR head SHA,
3. `decision === "go"`,
4. `finalizerKeyId` is not a producing worker key (independence).

`warn` reports violations without blocking; `enforce` blocks the merge (the G1
warn→enforce pattern).

## 5. Safety boundaries

- Public key ids only; private keys never emitted. Finalizer key
  issuance/rotation/revocation is operator-only.
- Verification failure is fail-closed.
- The gate enforces validity only — it never re-runs or overrides the judgment.
- `enforce` promotion is a separate operator cutoff decision.

## 6. Follow-ups

- **V-c** (A2A): a registered finalizer-key registry as a role disjoint from
  worker/broker keys — the structural source of independence.
- **Broker accept-path enforcement**: a broker-side variant of the gate reusing
  the #1382 complete-path pattern (this contract's v0 enforcement is the repo
  merge gate).
- **Auto-derived producing worker keys**: the gate should read the producing
  worker key ids from the round's `result.provenance` rather than a CLI arg.
- **Multi-finalizer panels** (M-of-N verdicts) for higher-stakes subjects.

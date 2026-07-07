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

## 2a. Verdict kinds — battery vs judgment (#1386 S2)

Every verdict declares its epistemic class in a required `kind` field, because
the two classes carry **different reproducibility guarantees** and must never
be conflated:

- **`battery`** — the outcome of deterministic, pinned checks. Re-running the
  same battery version on the same artifact reproduces the same verdict.
  Reproducibility is a real property of this kind.
- **`judgment`** — an attested independent judgment (e.g. an LLM or human
  finalizer review). It proves the review *occurred* and what it concluded;
  the judgment itself is **not reproducible** — a re-run may conclude
  differently. A judgment verdict's `assurance.doesNotProve` MUST include
  `"reproducibility"`, and the verifier fails it closed otherwise, so judgment
  verdicts can never borrow the reproducibility claim of battery verdicts.

The "anyone can re-run and get the same verdict" property holds for `battery`
verdicts only. Marketing or downstream consumers MUST NOT apply it to
`judgment` verdicts.

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
  "kind": "judgment",                               // battery | judgment (required — see §2a)
  "subject": { "kind": "pr", "prHeadSha": "…" },   // pr | task-result | round; resultHash / roundId for the others
  "decision": "go",                                 // go | no-go
  "evidenceRefs": [ { "kind": "red-green|conformance|suite", "ref": "…" } ],
  "assurance": {
    "proves": ["independent-review-occurred", "verdict-integrity", "subject-binding"],
    "doesNotProve": ["analytical-correctness", "reproducibility"],  // "reproducibility" REQUIRED for kind=judgment
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

## 4a. Attested identity — CI-OIDC authentication (S3 / #1386 H1)

A verdict authenticates by **exactly one** of two methods:

- **static key** — `finalizerKeyId` + `sig` resolved in the registered finalizer
  keyring (§3);
- **attester identity** — an `attester` block, when the verdict is produced in an
  attested execution environment (GitHub Actions + OIDC → Sigstore keyless) the
  operator does not control at signing time. This closes the subject-separation
  hole where the operator holds the signing key (design:
  `docs/specs/attested-finalizer-run.md`).

```jsonc
"attester": {
  "kind": "github-oidc",
  "subject": "repo:owner/name:workflow_ref:…:ref:refs/heads/main",  // the OIDC identity
  "leaf": "<PEM leaf certificate>",     // Fulcio-issued ephemeral cert; SAN URI = subject
  "sig": { "protected": "…", "signature": "…" },  // JWS over JCS(verdict sans attester.sig)
  "rekor": { "logIndex": …, "integratedTime": … } // transparency-log reference
}
```

Verifier checks (all fail-closed): the leaf **chains to a configured trusted
root** (Fulcio) — the load-bearing anchor, since the operator cannot mint a
passing identity without that root's key; `producedAt` is inside the leaf
validity window; the leaf **SAN equals `attester.subject`**; the leaf key signs
`JCS(verdict sans attester.sig)`; and a Rekor reference is present. The gate then
requires `attester.subject` to be in the **registered attester allowlist** (the
permitted finalizer workflow identities) and not a producing identity
(independence).

Independence on the attested path is checked on the **matching namespace**: an
`attester.subject` is a workflow identity, never a key id, so the gate compares
it against the **producing attester subjects** (gate input
`producingAttesterSubjects` / CLI `--producing-attester-subjects`), not against
producing worker key ids. The static-key path independence uses the disjoint
**producing worker key ids** axis. Comparing an attester subject against worker
key ids can never match and is not a real check (#1383 V-c A3).

**v0 boundary**: cert chain + SAN identity + validity + payload signature are
fully verified offline; the Rekor **inclusion-proof** math is the Sigstore
library / CI step and is only checked here for structural presence. And S3
reaches *unforgeable + publicly auditable*, not full principal separation — the
operator still triggers the run and authors the judgment content.

## 5. Safety boundaries

- Public key ids only; private keys never emitted. Finalizer key
  issuance/rotation/revocation is operator-only.
- Verification failure is fail-closed.
- The gate enforces validity only — it never re-runs or overrides the judgment.
- `enforce` promotion is a separate operator cutoff decision.

## 6. Follow-ups

- **V-c** (A2A): a registered finalizer-key registry as a role disjoint from
  worker/broker keys — the structural source of independence. **Disjointness is
  enforced by `scripts/validate-key-registry-disjoint.mjs`**: every keyId carries
  its role prefix (`worker:` / `finalizer:` / `broker:`), keyIds are globally
  unique, and — the load-bearing check — no public key is registered under two
  roles (normalized SPKI-PEM comparison, so the same keypair cannot be dual-role
  even across JWK/PEM serializations). Run it over the operator-held registries
  as a preflight; remaining V-c work is finalizer-keyring lifecycle fields
  (status/notBefore/expiresAt, reusing `request-security.ts` `parseRegistryLifecycle`).
- **Broker accept-path enforcement** (v0 landed, #1383 V-c): `completeTask`
  checks an opted-in task's verdict at the accept moment, before side-effects.
  Posture `A2A_FINALIZER_VERDICT_ENFORCEMENT=off|warn|enforce` (default off),
  scope `payload.requireFinalizerVerdict === true`, error `finalizer_verdict_invalid`.
  The broker checks STRUCTURE (schema, `decision === "go"`), SUBJECT-BINDING
  (`subject.resultHash === result.provenance.resultHash` — the canonical
  provenance-anchored result identity; a verdict-requiring completion must be
  provenance-anchored), and INDEPENDENCE (finalizer identity in the disjoint
  `finalizer:` role namespace and not the producing `result.provenance.workerKeyId`).
  **v0 boundary**: the broker does NOT verify the verdict SIGNATURE — the broker
  runtime cannot reuse the offline verifier (`scripts/lib`) without a JCS/JWS
  reimplementation, so signature authenticity and registered-key / attester-
  allowlist membership stay with the repo merge gate
  (`scripts/check-finalizer-verdict.mjs`), which MUST be wired as a required
  check when broker enforcement is on. The accept-path hook is defense-in-depth
  (block missing / wrong-decision / unbound / non-independent verdicts before
  side-effects). **In-broker static-key signature verification landed**: when a
  finalizer keyring is configured (`A2A_FINALIZER_KEYRING_FILE`, keyIds under the
  `finalizer:` role prefix), the accept-path verifies the static-key verdict
  SIGNATURE at completion time, reusing the broker's own rfc8785-jcs-v1 JCS +
  EdDSA (a golden JCS pin guards drift from the offline verifier). Without a
  keyring, signature authenticity stays deferred to the merge gate. The attester
  (S3) path's X509/Fulcio chain verification remains the merge gate's job (kept
  out of the completion hot path).
- **Auto-derived producing worker keys**: the gate should read the producing
  worker key ids from the round's `result.provenance` rather than a CLI arg.
- **Multi-finalizer panels** (M-of-N verdicts) for higher-stakes subjects.

# Design: Attested Finalizer Run (S3 / #1386 H1)

Status: design. Umbrella: strategy-review #1386 (S3). Builds on the signed
finalizer verdict + gate (#1383/#1384), the S2 verdict-kind split (#1387), and
composes with the certification track (#1385). Enabling infra for #1385's
attester (this is the first-party dogfood of that pattern).

## 1. Problem — the subject-separation hole (#1386 H1)

A finalizer verdict (#1383) is signed by a `finalizerKeyId` resolved in a
registered keyring, and the gate rejects self-certification. But **the operator
holds the worker, broker, and finalizer keys**. A skeptical third party cannot
distinguish "an independent finalizer rendered GO" from "the operator signed GO
with a key they control." Cryptography here proves role separation, not
interest separation — trust still reduces to *"trust the operator."* This
undercuts the "any third party can verify" claim the whole verified-evidence
stack rests on.

The finalizer that actually renders the judgment is a session-bounded agent that
**cannot custody a durable private key**; having the operator sign on its behalf
re-collapses independence. So the fix cannot be "give the finalizer a key."

## 2. Approach — move the signing authority into an environment the operator does not control at signing time

Produce the verdict inside an **attested execution environment**: GitHub Actions
+ OIDC → Sigstore keyless signing. The verdict's authority comes from the
**workflow identity** (repo + workflow path + ref + run), recorded in a public
transparency log (Rekor), not from a held key. This is the remote-attestation /
CI-OIDC provenance pattern (SLSA/Sigstore) — commodity plumbing we ride, never
rebuild (#1385 moat discipline).

The operator can still *trigger* the workflow, but cannot **forge** a verdict:
producing one requires a run of the pinned public workflow, and that run is
publicly logged. "The operator holds all keys" becomes "the operator cannot
produce a verdict without a public, unforgeable audit trail from an environment
they do not control at signing time."

## 3. What this closes — and what it does NOT (honest boundary)

**Closes:**
- Key custody: the finalizer needs no durable private key (keyless, short-lived
  cert — partially answers S4 expiry/revocation too).
- Silent verdicts: no GO can exist without a public workflow run + Rekor entry.

**Does NOT close:**
- The operator still triggers the run and still authors the judgment *content*
  (the LLM finalizer executes under the operator's account/repo). Full
  **principal separation** needs a finalizer operated by a distinct party. S3
  reaches **unforgeable + publicly auditable** — the step before independent
  principal, not principal separation itself.
- Trust now rests on GitHub OIDC + Sigstore/Rekor. That is deliberate (ride
  commodity plumbing); it is not our trust root to invent.
- The S2 kind boundary carries through: the `battery` portion is genuinely
  reproducible in CI; the `judgment` portion is attested-but-not-reproducible
  and must keep declaring `doesNotProve: reproducibility`.

## 4. Work units

### S3-a: attested-verdict identity contract
Extend `contracts/a2a/finalizer-verdict.md`: a verdict may be authenticated by an
**attester identity** instead of (or alongside) a static `finalizerKeyId`:

```jsonc
"attester": {
  "kind": "github-oidc",
  "subject": "repo:jinwon-int/a2a-nexus:workflow_ref:...:ref:refs/heads/main",
  "runId": "…",
  "sigstore": { "bundle": "…" }        // Rekor-logged keyless signing bundle
}
```

The gate resolves the attester `subject` against a **registered attester
allowlist** (the workflow identities permitted to finalize) — the OIDC analogue
of the registered finalizer keyring. Independence check becomes: the attester
identity is a finalizer workflow, distinct from any worker/producer identity.

### S3-b: verdict-assembly workflow (operator-gated)
`.github/workflows/finalizer-verdict.yml`, pinned, minimal, `permissions:
id-token: write` only:
1. input = the finalizer's judgment content (decision + `evidenceRefs`) posted
   by the session to the PR;
2. re-run the deterministic `battery` checks (reproducible portion);
3. assemble the verdict JSON bound to the PR head SHA;
4. keyless-sign via Sigstore/cosign using the GitHub OIDC token → Rekor;
5. attach the signed bundle to the PR.

Adding the workflow is a normal change; making it a **required** merge check is
an operator branch-protection action.

### S3-c: offline verifier extension
`scripts/verify-finalizer-verdict.mjs` accepts the attested form: verify the
Sigstore bundle offline, extract the OIDC subject, and check it matches the
expected finalizer workflow identity. Stays broker-independent (a third party
verifies against the public Rekor log + the bundle).

### S3-d: gate acceptance of attester identity
`scripts/check-finalizer-verdict.mjs` accepts an OIDC-attested verdict whose
attester subject is in the registered attester allowlist, in addition to the
existing static-key path. `warn`→`enforce` (G1 pattern).

## 5. Evidence gate

- **RED**: a verdict "signed" by an operator-held key with no attester identity
  is accepted by the gate as an independent finalization (current state — the
  H1 hole).
- **GREEN**: the gate accepts a verdict only when it carries a valid Sigstore
  bundle whose OIDC subject is a registered finalizer workflow (offline-verifiable
  against Rekor), and rejects fabricated/absent attester identities fail-closed;
  the `battery` re-run in CI reproduces the deterministic checks.

## 6. Safety boundaries

- No private key material anywhere (keyless is the point). Attester allowlist
  changes and branch-protection promotion are operator-only.
- Verifier/gate remain fail-closed and broker-independent.
- Does not deploy/restart anything; the workflow runs in CI, not the broker/worker
  fleet.

## 7. Split

- **Direct PR**: S3-a (contract), S3-c (verifier extension), S3-d (gate
  extension) — offline scripts/contract, mirrors #1381/#1383.
- **Operator / CI**: S3-b (the signing workflow with `id-token` permission) and
  making it a required check — security infra + branch protection.
- **Composition**: this substrate is exactly #1385's attester; building it for
  our own verdicts de-risks the certification product. Partially answers S4
  (short-lived keyless certs).

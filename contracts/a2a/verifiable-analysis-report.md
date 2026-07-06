# Contract: Verifiable Analysis Report v1

Status: v1. Umbrella: #1378. **Replaces v0** — v0 defined a parallel signing
scheme; v1 aligns the bundle to the broker's ACTUAL provenance primitives
landed in #1380 (`packages/broker/src/core/provenance.ts`), so there is exactly
one canonicalization + signature path across the system.

This contract defines a **self-contained report bundle** that ships alongside a
round result and can be verified **offline, by a third party, without the
broker**. It is the smallest concrete atom of the "verified evidence data
layer" thesis (#1298): it moves a round output from *"I verified it"* to
*"anyone can verify it."*

The bundle is a **projection** of the emit-side structures (#1380 result
provenance + retrieval snapshots) plus the report envelope and the
correctness-separation invariant. The reference verifier
(`scripts/verify-analysis-report.mjs`) is the authority on acceptance.

## 1. What this proves — and what it does NOT

The load-bearing boundary of the whole design.

- **Proves**: process provenance (*who* produced the result, and that each cited
  source snapshot is authentic), and integrity (signed content was *not
  tampered* after production).
- **Does NOT prove**: that the analysis is **correct**, or that any judgment is
  **right**. Provenance is cryptographic; correctness is not. A signed wrong
  analysis is a wrong analysis with good provenance.

A conforming bundle MUST carry an `assurance` block declaring this, and the
verifier MUST refuse GREEN for a bundle that omits it — so no report can present
itself as certifying correctness.

## 2. Canonicalization + signatures (inherited from #1380 / agent-card-signing)

- **Canonicalization**: RFC 8785 (JCS), exactly `canonicalizeJson`
  (`packages/broker/src/a2a/agent-card-signing.ts`) — sorted keys, `undefined`
  dropped, ES6 number/string serialization. Labeled `rfc8785-jcs-v1`.
- **Signatures**: A2A 1.0 JWS. Each signature is `{ protected, signature }`
  where `signature` covers `${protected}.${base64url(JCS(payload))}`. `alg` is
  `EdDSA` (ed25519) or `ES256` (P-256, JOSE-raw `r||s`).

The independent verifier re-implements JCS + JWS verification standalone (only
`node:crypto`) so a third party needs neither the broker nor this monorepo — the
whole point of offline verification. The re-implementation mirrors
`agent-card-signing.ts`; a dev-time round-trip against the real `#1380` signers
confirms byte-compatibility (see PR evidence). `sha256:<hex>` is lowercase-hex
SHA-256 over canonical UTF-8 bytes.

## 3. Bundle shape

```jsonc
{
  "reportVersion": "verifiable-analysis-report/v1",
  "taskId": "…",
  "result": {                              // the task result, carrying #1380 provenance
    "summary": "…",
    "output": { "…": "…" },
    "provenance": {                        // #1380 TaskResultProvenance
      "schemaVersion": "a2a.result.provenance.v1",
      "canonicalization": "rfc8785-jcs-v1",
      "alg": "EdDSA",
      "workerKeyId": "…",                  // public key id only — never a private key, never a real worker name
      "claimedAt": "ISO-8601",
      "resultHash": "sha256:…",            // sha256(JCS(result WITHOUT result.provenance))
      "workerSig": { "protected": "…", "signature": "…" },
      "brokerCountersig": {
        "brokerKeyId": "…",
        "verifiedAt": "ISO-8601",
        "sig": { "protected": "…", "signature": "…" }
      }
    }
  },
  "sources": [                             // #1380 signed RetrievalSnapshot[] (may be empty)
    {
      "schemaVersion": "a2a.retrieval.snapshot.v1",
      "canonicalization": "rfc8785-jcs-v1",
      "source": "github",
      "repo": "…", "requestedRef": "…", "resolvedRef": "…", "path": "…",
      "fetchedAt": "ISO-8601",
      "byteLen": 0,
      "contentHash": "sha256:…",
      "content": "…",
      "signature": { "protected": "…", "signature": "…" }
    }
  ],
  "assurance": {                           // correctness-separation invariant (REQUIRED)
    "proves": ["source-grounding", "integrity", "process-provenance"],
    "doesNotProve": ["analytical-correctness", "normative-judgment"],
    "disclaimer": "This report proves how the result was produced and that it was not tampered with. It does NOT certify that the analysis is correct."
  }
}
```

### Signing payloads (frozen in #1380)

- `provenance.resultHash` = `sha256:` + sha256(JCS(`result` sans `result.provenance`)).
- **workerSig** covers `JCS({ schemaVersion, canonicalization, taskId, claimedAt, resultHash })`.
  Binding `taskId` prevents cross-task replay.
- **brokerCountersig.sig** covers
  `JCS({ schemaVersion:"a2a.result.provenance.broker-countersig.v1", canonicalization, taskId, verifiedAt, workerSig })`.
- **snapshot signature** covers `JCS(snapshot sans signature)` — the whole tuple
  (content + repo/ref/path metadata), not the content hash alone.

## 4. Verification (all checks fail-closed; GREEN requires every check to pass)

1. **Shape** — required fields present; `reportVersion` matches.
2. **Assurance invariant** — `assurance.doesNotProve` includes
   `analytical-correctness` and `normative-judgment`; `disclaimer` non-empty.
3. **Provenance schema** — `schemaVersion`/`canonicalization` supported.
4. **Result-hash binding** — recompute `sha256(JCS(result sans provenance))`,
   assert equals `provenance.resultHash`. (Master tamper check.)
5. **Worker signature** — resolve `workerKeyId` in the keyring; verify. Absent
   key ⇒ fail-closed.
6. **Broker countersignature** — resolve `brokerKeyId`; verify.
7. **Per-source snapshot** — recompute `byteLen` + `contentHash`; resolve the
   snapshot signing key by the JWS `kid`; verify the whole-tuple signature.

Keyring: `{ "keys": { "<keyId>": "<PEM public key>" } }`, supplied by the
consumer. No private key material appears in a bundle, keyring, log, or issue.

## 5. Known limitation — result↔source binding (next K2 wiring)

v1 verifies the result's authenticity AND each source snapshot's authenticity
**independently**. It does NOT yet cryptographically prove *which* sources fed
*this* result, because #1380 does not embed source `contentHash`es into the
signed `result`. The binding step: the K2 executor should record the consumed
source hashes inside the `result` (so `resultHash` covers them); the verifier
then asserts every `sources[i].contentHash` is referenced by the result. Tracked
against K2 (#1374). Until then, a report asserts "this result is authentic and
these snapshots are authentic," not "this result was derived from exactly these
snapshots."

## 6. Safety boundaries

- Public key ids only; private keys never emitted anywhere.
- Attested subject is an anonymized class / key id — never a real worker name.
- Verification failure is fail-closed — no partial-trust state.
- Backward compatible on the emit side: a result without a bundle is unchanged.
- Reuse existing deployed signing keys; do not invent a new key-distribution
  scheme. Rotation/revocation is operator-only.

## 7. Follow-up

- A permanent CI conformance guard (round-trip `#1380` real signers → this
  verifier) should live where the broker dist is built after the release-gate
  build barrier; the committed script test is self-contained and the dev-time
  round-trip covers byte-compatibility in the interim.
